import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { ensureCommands, resetCommandChecks } from "../src/discord.js";
import { COMMANDS } from "../src/commands.js";

const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Send `body` to the Worker the way Discord does: signed with the app's key. */
async function discordSends(t, body, envExtra = {}) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = JSON.stringify(body);
  const ts = "1760000000";
  const sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(ts + raw)));
  const env = {
    DISCORD_PUBLIC_KEY: toHex(await crypto.subtle.exportKey("raw", keys.publicKey)),
    DISCORD_APP_ID: "app", DISCORD_BOT_TOKEN: "token",
    GOOGLE_CREDENTIALS: JSON.stringify({ client_email: "bot@example.com", private_key: "unused" }),
    SIGNUP_FORM_URL: "https://forms.example/signup", RANKINGS_URL: "https://standings.example/",
    ...envExtra
  };
  const background = [];
  t.mock.method(globalThis, "fetch", async () => new Response("[]"));
  t.mock.method(console, "error", () => {});
  const res = await worker.fetch(
    new Request("https://worker/", { method: "POST", body: raw, headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts } }),
    env, { waitUntil: (p) => background.push(p) }
  );
  await Promise.all(background);
  return { res, json: await res.json(), calls: globalThis.fetch.mock.calls.map((c) => [String(c.arguments[0]), c.arguments[1]?.method || "GET"]) };
}

test("/rb-bot shows anybody the full panel, privately, with no officer role", async (t) => {
  resetCommandChecks();
  const { json } = await discordSends(t, {
    type: 2, token: "tok", guild_id: "guild1", channel_id: "c",
    data: { name: "rb-bot" }, member: { roles: [], permissions: "0", user: { id: "1", username: "newbie" } }
  });
  assert.equal(json.type, 4, "answers straight away, no deferral");
  assert.equal(json.data.flags, 64, "only the person who asked sees it");
  assert.equal(json.data.embeds[0].title, "Riftbound check-in");
  const labels = json.data.components.map((row) => row.components.map((b) => b.label));
  assert.deepEqual(labels, [["Check in", "Am I in?", "Events", "My signups"], ["Sign up", "Rankings"]]);
});

test("using the bot in a server brings that server's command list up to date", async (t) => {
  resetCommandChecks();
  const { calls } = await discordSends(t, {
    type: 2, token: "tok", guild_id: "guild2", channel_id: "c",
    data: { name: "rb-bot" }, member: { roles: [], permissions: "0", user: { id: "1", username: "newbie" } }
  });
  assert.ok(calls.some(([u, m]) => u.endsWith("/applications/app/guilds/guild2/commands") && m === "GET"));
  assert.ok(calls.some(([u, m]) => u.endsWith("/applications/app/guilds/guild2/commands") && m === "PUT"),
    "Discord had no commands, so the list is pushed");
});

/** Discord's copy of a command: ours plus the fields it adds, and null where we left one out. */
const asDiscordReturns = (c, i) => ({
  id: String(i), application_id: "app", version: "1", type: 1, nsfw: false,
  default_member_permissions: c.default_member_permissions ?? null,
  ...c,
  options: c.options?.map((o) => ({ required: false, ...o }))
});

test("the command check leaves a current list alone and pushes a stale one", async (t) => {
  resetCommandChecks();
  let have = COMMANDS.map(asDiscordReturns);
  const puts = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (init.method === "PUT") { puts.push(url); return new Response("[]"); }
    return new Response(JSON.stringify(have));
  });
  assert.equal(await ensureCommands("t", "app", "g1", COMMANDS, 1e9), "unchanged");
  have = have.filter((c) => c.name !== "rb-bot");
  assert.equal(await ensureCommands("t", "app", "g2", COMMANDS, 1e9), "synced");
  assert.equal(puts.length, 1);
});

test("the command check runs at most every ten minutes per server", async (t) => {
  resetCommandChecks();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(COMMANDS.map(asDiscordReturns))));
  assert.equal(await ensureCommands("t", "app", "g", COMMANDS, 1e9), "unchanged");
  assert.equal(await ensureCommands("t", "app", "g", COMMANDS, 1e9 + 60_000), "skipped");
  assert.equal(await ensureCommands("t", "app", "g", COMMANDS, 1e9 + 11 * 60_000), "unchanged");
  assert.equal(await ensureCommands("t", "app", null, COMMANDS, 1e9), "skipped", "no server, nothing to check");
});

const asMember = (roles, permissions = "0") => ({
  type: 2, token: "tok", guild_id: "guild9", channel_id: "chan9",
  data: { name: "panel" }, member: { roles, permissions, user: { id: "1", username: "someone" } }
});

test("/panel turns away anyone below Officer", async (t) => {
  resetCommandChecks();
  const { json, calls } = await discordSends(t, asMember(["member"]), { ORGANIZER_ROLE_IDS: "officer-role" });
  assert.equal(json.type, 4);
  assert.match(json.data.content, /Officers only/);
  assert.ok(!calls.some(([u, m]) => u.includes("/channels/chan9/messages") && m === "POST"), "nothing posted");
});

test("/panel from an officer posts the panel publicly and refreshes commands", async (t) => {
  resetCommandChecks();
  const ADMIN = String(1n << 3n);
  const { json, calls } = await discordSends(t, asMember([], ADMIN), { ORGANIZER_ROLE_IDS: "officer-role" });
  assert.equal(json.type, 5, "acknowledged, finished in the background");
  const post = globalThis.fetch.mock.calls.find((c) => String(c.arguments[0]).includes("/channels/chan9/messages"));
  assert.ok(post, "panel posted in the channel");
  const sent = JSON.parse(post.arguments[1].body);
  assert.equal(sent.flags, undefined, "public, not private");
  assert.equal(sent.embeds[0].title, "Riftbound check-in");
  assert.ok(calls.some(([u]) => u.includes("/users/@me/guilds")), "every server's commands checked");
  const reply = globalThis.fetch.mock.calls.find((c) => String(c.arguments[0]).includes("/messages/@original"));
  assert.match(JSON.parse(reply.arguments[1].body).content, /Panel posted/);
});
