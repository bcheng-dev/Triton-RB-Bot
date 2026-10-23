/* Discord's HTTP interactions transport.

   There is no bot process holding a socket open here. Discord POSTs to this Worker
   whenever somebody clicks, the Worker answers, and then it stops existing. That is
   why it is always available: there is nothing to keep running. */

const enc = new TextEncoder();

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Discord signs every request. An unsigned or badly signed one must get a 401,
    and Discord actively tests this when you save the endpoint URL. */
export async function verify(request, body, publicKey) {
  const sig = request.headers.get("x-signature-ed25519");
  const ts = request.headers.get("x-signature-timestamp");
  if (!sig || !ts) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" }, key, hexToBytes(sig), enc.encode(ts + body)
    );
  } catch (err) {
    console.error("signature check threw:", err && err.message);
    return false;
  }
}

export const T = { PING: 1, COMMAND: 2, COMPONENT: 3 };
export const R = { PONG: 1, MESSAGE: 4, DEFER: 5 };
export const EPHEMERAL = 64;

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** Tell Discord "working on it", privately. We have 3 seconds to say this; the real
    answer can take as long as it needs and is edited in afterwards. */
export const defer = () => json({ type: R.DEFER, data: { flags: EPHEMERAL } });

/** Replace that placeholder with the real answer. */
export async function followUp(appId, token, content) {
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }
  );
  if (!res.ok) console.error("followUp failed", res.status, await res.text());
}

/** Re-send the slash command list to this server. Same list as register.js. */
export async function syncCommands(botToken, appId, guildId, commands) {
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bot ${botToken}` },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`command sync failed: ${res.status} ${await res.text()}`);
}

/** The server's roles with their positions; a higher position ranks higher. */
export async function guildRoles(botToken, guildId) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
    headers: { authorization: `Bot ${botToken}` }
  });
  if (!res.ok) throw new Error(`role list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Every button on the panel, with the line that explains it. The embed's guide is
    built from this same list, so a button and its explanation always share an emoji.
    Action buttons send the bot an interaction; link buttons just open a page. */
function panelButtons(opensMinutes, { signupUrl, feedbackUrl, rankingsUrl } = {}) {
  return [
    { emoji: "✅", label: "Check in", style: 3, id: "rb:checkin",
      help: `marks you present at the event. Works from ${opensMinutes} minutes before the event starts until it ends.` },
    { emoji: "❓", label: "Am I in?", style: 2, id: "rb:status",
      help: "tells you if you're already checked in." },
    { emoji: "📅", label: "Events", style: 2, id: "rb:events",
      help: "shows upcoming events, their times, where they are, and when check-in opens." },
    { emoji: "📋", label: "My signups", style: 2, id: "rb:mine",
      help: "shows every upcoming event with ✅ if you're signed up and ❌ if not." },
    { emoji: "📝", label: "Sign up", url: signupUrl,
      help: "opens the signup form. Pick the event date you're coming to." },
    { emoji: "💬", label: "Feedback", url: feedbackUrl,
      help: "tell us how the event went." },
    { emoji: "🏆", label: "Rankings", url: rankingsUrl,
      help: "see the current standings." }
  ].filter((b) => b.id || b.url);   // a link with no address configured is left out
}

/** The panel: a guide to the buttons, and the buttons. /rb-bot shows it to whoever
    asks, as a private reply. */
export function panelMessage(opensMinutes, links = {}) {
  const buttons = panelButtons(opensMinutes, links);
  const component = (b) => b.id
    ? { type: 2, style: b.style, label: b.label, emoji: { name: b.emoji }, custom_id: b.id }
    : { type: 2, style: 5, label: b.label, emoji: { name: b.emoji }, url: b.url };
  // Actions on the first row, links on the second: a row holds at most five buttons.
  const rows = [buttons.filter((b) => b.id), buttons.filter((b) => b.url)]
    .filter((r) => r.length)
    .map((r) => ({ type: 1, components: r.map(component) }));
  return {
    embeds: [{
      title: "Riftbound check-in",
      description: buttons.map((b) => `${b.emoji} **${b.label}**: ${b.help}`).join("\n") +
        "\n\nType `/rb-bot` any time to bring this up. Replies are only visible to you.",
      color: 0x1c5f7c,
      footer: { text: `Check-in opens ${opensMinutes} minutes before each event starts and closes when it ends.` }
    }],
    components: rows
  };
}

/* ---------- Keeping the command list current, with nobody having to do anything ---------- */

/** What matters about a command when comparing ours with what Discord has. */
const fingerprint = (c) => JSON.stringify([
  c.name, c.description, String(c.default_member_permissions ?? ""),
  (c.options || []).map((o) => [o.name, o.type, !!o.required, o.description])
]);
const checkedAt = new Map();   // guild ID → last check, per warm Worker
const CHECK_EVERY_MS = 10 * 60 * 1000;

/** Make this server's commands match ours, quietly, when they have drifted: a new
    server the bot just joined, or a deploy that added a command. Checks at most once
    every ten minutes per server per warm Worker, so it costs almost nothing.
    Returns "skipped", "unchanged" or "synced". */
export async function ensureCommands(botToken, appId, guildId, commands, now = Date.now()) {
  if (!guildId) return "skipped";
  if (now - (checkedAt.get(guildId) || 0) < CHECK_EVERY_MS) return "skipped";
  checkedAt.set(guildId, now);
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
    headers: { authorization: `Bot ${botToken}` }
  });
  if (!res.ok) throw new Error(`command list failed: ${res.status} ${await res.text()}`);
  const have = (await res.json()).map(fingerprint).sort().join("\n");
  const want = commands.map(fingerprint).sort().join("\n");
  if (have === want) return "unchanged";
  await syncCommands(botToken, appId, guildId, commands);
  return "synced";
}

let guildsCheckedAt = 0;

/** The same check for every server the bot is in. A server it was just added to has
    no commands at all, so nobody there can use the bot to set them up; any use of the
    bot in another server does it instead. The server in use goes first. */
export async function ensureAllGuilds(botToken, appId, currentGuildId, commands, now = Date.now()) {
  const results = {};
  if (currentGuildId) results[currentGuildId] = await ensureCommands(botToken, appId, currentGuildId, commands, now);
  if (now - guildsCheckedAt < CHECK_EVERY_MS) return results;
  guildsCheckedAt = now;
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds?limit=200", {
    headers: { authorization: `Bot ${botToken}` }
  });
  if (!res.ok) throw new Error(`guild list failed: ${res.status} ${await res.text()}`);
  for (const g of await res.json()) {
    if (g.id in results) continue;
    try {
      results[g.id] = await ensureCommands(botToken, appId, g.id, commands, now);
    } catch (err) {
      console.error(`command check failed for ${g.name || g.id}`, err);
      results[g.id] = "failed";
    }
  }
  return results;
}

/** For tests: forget when each server was last checked. */
export const resetCommandChecks = () => { checkedAt.clear(); guildsCheckedAt = 0; };
