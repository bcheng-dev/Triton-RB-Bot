/* Riftbound check-in, as a Cloudflare Worker.

   Nothing runs between clicks. Discord POSTs here when somebody presses the button,
   this answers, and the Worker goes away again. That is what makes it always
   available on a free plan: there is no process to keep alive and nothing to sleep. */
import {
  verify, T, R, EPHEMERAL, json, defer, followUp, postPanel, panelMessage,
  syncCommands, syncAllGuilds, ensureCommands, guildRoles
} from "./discord.js";
import { Sheet } from "./google.js";
import { COMMANDS } from "./commands.js";
import {
  checkIn, amIIn, checkInFor, uncheck, attendance,
  parseEvents, applyEvents, addEvent, removeEvent, listEvents, mySignups
} from "./logic.js";

function config(env) {
  const signupTab = env.SIGNUP_TAB || "Form Responses 1";
  return {
    tz: env.TIMEZONE || "America/Los_Angeles",
    signupTab,
    defaultTab: signupTab,
    attendanceTab: env.ATTENDANCE_TAB || "Attendance",
    eventsTab: env.EVENTS_TAB || "Events",
    opensMinutes: Number(env.CHECKIN_OPENS_MINUTES || 30),
    colName: env.COL_NAME || "Name",
    colDiscord: env.COL_DISCORD || "Discord",
    colVerifiedId: env.COL_VERIFIED_ID || "Discord ID (verified)",
    colChecked: env.COL_CHECKED || "Checked in",
    colEvent: env.COL_EVENT || "",
    formUrl: env.SIGNUP_FORM_URL || "",
    feedbackUrl: env.FEEDBACK_FORM_URL || "",
    rankingsUrl: env.RANKINGS_URL || ""
  };
}

/** Secrets piped in from Windows PowerShell can arrive with a byte order mark in
    front, and pasted ones with stray spaces. Either breaks a key, an ID or a URL in
    ways that only show up as Discord refusing to verify. Strip them once here. */
export function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" ? v.replace(/^\uFEFF/, "").trim() : v;
  }
  return out;
}

/** Organizer gate.

    Administrators always pass; Discord reports the server owner as having every
    permission, so that covers the owner too. With ORGANIZER_ROLE_IDS set (the
    Officer role; one ID per server when the bot is in several), a member passes
    with that role or any role ranked above it, so President and the like count
    without being listed. Roles Discord or other bots manage, such as Server Booster,
    never count, wherever they sit, and neither do roles in ORGANIZER_IGNORE_ROLE_IDS
    (Alumni Officer and the like). Ignoring a role does not lock its holder out: a
    current officer who is also an alumnus still passes on their Officer role.
    Without ORGANIZER_ROLE_IDS, Manage Events or Manage Server is enough. */
const ADMINISTRATOR = 1n << 3n;
const MANAGE_EVENTS = 1n << 33n;
const MANAGE_GUILD = 1n << 5n;
const idList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
export async function isOrganizer(body, env, loadRoles = guildRoles) {
  const perms = BigInt(body.member?.permissions || "0");
  if ((perms & ADMINISTRATOR) !== 0n) return true;

  const ids = idList(env.ORGANIZER_ROLE_IDS);
  if (!ids.length) return (perms & MANAGE_EVENTS) !== 0n || (perms & MANAGE_GUILD) !== 0n;

  const mine = body.member?.roles || [];
  if (ids.some((id) => mine.includes(id))) return true;
  if (!mine.length || !body.guild_id) return false;

  const ignored = new Set(idList(env.ORGANIZER_IGNORE_ROLE_IDS));
  try {
    const roles = (await loadRoles(env.DISCORD_BOT_TOKEN, body.guild_id))
      .filter((r) => !r.managed && !ignored.has(r.id));
    const position = new Map(roles.map((r) => [r.id, r.position]));
    const floors = ids.filter((id) => position.has(id)).map((id) => position.get(id));
    if (!floors.length) return false;   // no organizer role exists in this server
    const floor = Math.min(...floors);
    return mine.some((id) => position.has(id) && position.get(id) >= floor);
  } catch (err) {
    console.error("could not read the server's roles", err);
    return false;
  }
}

/** The user who clicked. In a guild this is member.user; in a DM it is user. */
function who(body) {
  const u = body.member?.user || body.user || {};
  return {
    id: u.id,
    username: u.username,
    globalName: u.global_name,
    nickname: body.member?.nick || undefined
  };
}

function optionMap(body) {
  const out = {};
  (body.data?.options || []).forEach((o) => { out[o.name] = o.value; });
  return out;
}

/** The member an organizer picked with `member:`, if any. */
function pickedMember(body, opts) {
  const u = opts.member ? (body.data?.resolved?.users || {})[opts.member] : null;
  return u ? { id: u.id, username: u.username, globalName: u.global_name } : null;
}

/** Turn an exception into something a person can act on. */
function explain(err) {
  console.error(err);
  if (String(err.message) === "SHEET_FORBIDDEN") {
    return "I cannot open the signup sheet. An organizer needs to share it with the bot's service account address as an Editor.";
  }
  return "Something went wrong talking to the sheet. Tell an organizer; the Worker log has the detail.";
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    if (request.method === "GET") {
      return new Response("Riftbound check-in worker is up.", { status: 200 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();
    if (!(await verify(request, raw, env.DISCORD_PUBLIC_KEY))) {
      return new Response("Bad request signature", { status: 401 });
    }

    const body = JSON.parse(raw);
    if (body.type === T.PING) return json({ type: R.PONG });

    /* Any use of the bot in a server quietly brings that server's slash commands up
       to date, so a server it just joined, or a newly added command, needs nobody
       to run /panel first. Runs after the reply; never slows the click down. */
    if (body.guild_id) {
      ctx.waitUntil(
        ensureCommands(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID, body.guild_id, COMMANDS)
          .catch((err) => console.error("command check failed", err))
      );
    }

    const cfg = config(env);
    const links = { signupUrl: cfg.formUrl, feedbackUrl: cfg.feedbackUrl, rankingsUrl: cfg.rankingsUrl };
    const reply = (content) => json({ type: R.MESSAGE, data: { content, flags: EPHEMERAL } });

    /* A half-pasted secret would otherwise throw here, and Discord would only show
       "This interaction failed" with no hint why. */
    let creds;
    try {
      creds = JSON.parse(env.GOOGLE_CREDENTIALS);
      if (!creds.client_email || !creds.private_key) throw new Error("incomplete");
    } catch (err) {
      console.error("GOOGLE_CREDENTIALS is missing or not the full service account JSON", err);
      return reply("The bot's Google credentials are missing or incomplete. An organizer needs to re-run `wrangler secret put GOOGLE_CREDENTIALS` with the whole service account JSON.");
    }
    const sheet = new Sheet(creds, env.SHEET_ID, cfg);

    /* Everything past here touches Google, which is slower than Discord's three
       second deadline allows for. So: acknowledge now, finish in the background.
       The schedule is read first, because it decides which signup tab to use. */
    const background = (work) => {
      ctx.waitUntil(
        (async () => {
          applyEvents(cfg, parseEvents(await sheet.readEvents(), cfg));
          return work();
        })()
          .then((text) => followUp(env.DISCORD_APP_ID, body.token, text))
          .catch((err) => followUp(env.DISCORD_APP_ID, body.token, explain(err)))
      );
      return defer();
    };

    if (body.type === T.COMPONENT) {
      const id = body.data?.custom_id;
      if (id === "rb:checkin") return background(() => checkIn(sheet, cfg, who(body)));
      if (id === "rb:status")  return background(() => amIIn(sheet, cfg, who(body)));
      if (id === "rb:events")  return background(async () => listEvents(cfg));
      if (id === "rb:mine")    return background(() => mySignups(sheet, cfg, who(body)));
      return reply("I do not know that button.");
    }

    if (body.type === T.COMMAND) {
      const name = body.data?.name;
      const opts = optionMap(body);

      // The panel for one person, privately. No sheet, no posting, no organizer
      // check: anybody can summon it, and its buttons work like the pinned one's.
      if (name === "rb-bot") {
        return json({ type: R.MESSAGE, data: { ...panelMessage(cfg.opensMinutes, links), flags: EPHEMERAL } });
      }
      const organizerOnly = ["panel", "event-add", "event-remove", "checkin-for", "uncheckin", "attendance"];
      if (organizerOnly.includes(name) && !(await isOrganizer(body, env))) return reply("Officers only.");

      if (name === "checkin") return background(() => checkIn(sheet, cfg, who(body)));
      if (name === "events") return background(async () => listEvents(cfg));
      if (name === "mysignups") return background(() => mySignups(sheet, cfg, who(body)));

      if (name === "panel") {
        return background(async () => {
          let synced;
          try {
            const { synced: n, failed } = await syncAllGuilds(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID, COMMANDS);
            synced = `Commands refreshed in ${n} server${n === 1 ? "" : "s"}.` +
              (failed.length ? ` Could not refresh: ${failed.join(", ")}.` : "");
          } catch (err) {
            // Listing servers failed; still refresh this one.
            console.error(err);
            try {
              await syncCommands(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID, body.guild_id, COMMANDS);
              synced = "Commands refreshed in this server.";
            } catch (err2) {
              console.error(err2);
              synced = "Could not refresh the command list; the Worker log has the detail.";
            }
          }
          await postPanel(env.DISCORD_BOT_TOKEN, body.channel_id, cfg.opensMinutes, links);
          return `Panel posted. ${synced}`;
        });
      }

      if (name === "event-add") {
        return background(() => addEvent(sheet, cfg, { ...opts, by: who(body).username }));
      }
      if (name === "event-remove") return background(() => removeEvent(sheet, cfg, opts));

      if (name === "checkin-for") {
        return background(() => checkInFor(sheet, cfg, {
          target: pickedMember(body, opts), name: opts.name || null, by: who(body).username
        }));
      }

      if (name === "uncheckin") {
        // With nothing picked, an organizer is undoing their own test check-in.
        const target = pickedMember(body, opts) || (opts.name ? null : who(body));
        return background(() => uncheck(sheet, cfg, {
          target, name: opts.name || null, by: who(body).username
        }));
      }

      if (name === "attendance") return background(() => attendance(sheet, cfg));

      return reply("Unknown command.");
    }

    return json({ type: R.PONG });
  }
};
