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

/** Push the command list to every server the bot is in, so a server it was just
    added to gets its commands the next time an organizer anywhere runs /panel.
    Returns how many servers took it and which ones failed. */
export async function syncAllGuilds(botToken, appId, commands) {
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds?limit=200", {
    headers: { authorization: `Bot ${botToken}` }
  });
  if (!res.ok) throw new Error(`guild list failed: ${res.status} ${await res.text()}`);
  const guilds = await res.json();
  const failed = [];
  for (const g of guilds) {
    try {
      await syncCommands(botToken, appId, g.id, commands);
    } catch (err) {
      console.error(err);
      failed.push(g.name || g.id);
    }
  }
  return { synced: guilds.length - failed.length, failed };
}

/** The panel: an embed and its buttons. /panel posts it in the channel for everyone;
    /rb-bot shows the same thing to one person as a private reply. */
export function panelMessage(opensMinutes, { signupUrl, feedbackUrl, rankingsUrl } = {}) {
  const actions = [
    { type: 2, style: 3, label: "Check in", emoji: { name: "✅" }, custom_id: "rb:checkin" },
    { type: 2, style: 2, label: "Am I in?", custom_id: "rb:status" },
    { type: 2, style: 2, label: "Events", emoji: { name: "📅" }, custom_id: "rb:events" },
    { type: 2, style: 2, label: "My signups", emoji: { name: "📋" }, custom_id: "rb:mine" }
  ];
  // Link buttons open a form directly; Discord handles them, no interaction is sent.
  // They get their own row because a row holds at most five buttons.
  const links = [];
  if (signupUrl) links.push({ type: 2, style: 5, label: "Sign up", emoji: { name: "📝" }, url: signupUrl });
  if (feedbackUrl) links.push({ type: 2, style: 5, label: "Feedback", emoji: { name: "💬" }, url: feedbackUrl });
  if (rankingsUrl) links.push({ type: 2, style: 5, label: "Rankings", emoji: { name: "🏆" }, url: rankingsUrl });
  const rows = [{ type: 1, components: actions }];
  if (links.length) rows.push({ type: 1, components: links });
  return {
    embeds: [{
      title: "Riftbound check-in",
      description: "Signed up on the form? Hit **Check in** and I will mark you present.\n\n" +
        "**Events** shows what is coming up, and **My signups** which of those you are down for. " +
        "**Sign up** opens the form; pick the date you are coming. **Feedback** tells us how it went, and **Rankings** shows the standings.\n\n" +
        "Replies are only visible to you.",
      color: 0x1c5f7c,
      footer: { text: `Check-in opens ${opensMinutes} minutes before each event starts and closes when it ends.` }
    }],
    components: rows
  };
}

/** Post the check-in panel into a channel. Needs the bot token, not the interaction.
    It gets pinned and reused for every event, so it names no particular event. */
export async function postPanel(botToken, channelId, opensMinutes, links = {}) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bot ${botToken}` },
    body: JSON.stringify(panelMessage(opensMinutes, links))
  });
  if (!res.ok) throw new Error(`panel post failed: ${res.status} ${await res.text()}`);
}

/* ---------- Keeping the command list current without anybody running /panel ---------- */

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

/** For tests: forget when each server was last checked. */
export const resetCommandChecks = () => checkedAt.clear();
