import test from "node:test";
import assert from "node:assert/strict";
import { panelMessage, ensureAllGuilds, resetCommandChecks } from "../src/discord.js";
import { COMMANDS } from "../src/commands.js";

const ALL = { signupUrl: "https://forms.example/signup", feedbackUrl: "https://forms.example/feedback", rankingsUrl: "https://standings.example/" };
const labels = (msg) => msg.components.map((row) => row.components.map((b) => b.label));

test("the panel puts actions on one row and links on a second", () => {
  const rows = labels(panelMessage(30, ALL));
  assert.deepEqual(rows, [["Check in", "Am I in?", "Events", "My signups"], ["Sign up", "Feedback", "Rankings"]]);
  assert.ok(rows.every((r) => r.length <= 5), "Discord allows at most five buttons in a row");
});

test("every button has an emoji, and the guide explains each in plain text", () => {
  const msg = panelMessage(30, ALL);
  const guide = msg.embeds[0].description.split("\n");
  for (const b of msg.components.flatMap((row) => row.components)) {
    assert.ok(b.emoji?.name, `${b.label} needs an emoji`);
    assert.ok(guide.some((line) => line.startsWith(`**${b.label}**:`)), `guide line for ${b.label}`);
    assert.ok(!guide.some((line) => line.startsWith(b.emoji.name)), `no emoji in front of ${b.label}'s line`);
  }
});

test("the guide uses the configured check-in window and points at /rb-bot", () => {
  const text = panelMessage(45, ALL).embeds[0];
  assert.match(text.description, /Works from 45 minutes before/);
  assert.match(text.description, /`\/rb-bot`/);
  assert.match(text.footer.text, /45 minutes/);
});

test("link buttons and their guide lines are left out when no link is set", () => {
  const msg = panelMessage(30, { feedbackUrl: ALL.feedbackUrl });
  assert.deepEqual(labels(msg), [["Check in", "Am I in?", "Events", "My signups"], ["Feedback"]]);
  assert.doesNotMatch(msg.embeds[0].description, /Sign up|Rankings/);
  assert.equal(panelMessage(30, {}).components.length, 1);
});

test("/panel is for officers; /rb-bot is for everyone", () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.equal(byName.panel.default_member_permissions, String(1n << 33n), "hidden from members without Manage Events");
  assert.equal(byName["rb-bot"].default_member_permissions, undefined, "visible to everyone");
});

test("using the bot anywhere sets up every server, including one with no commands yet", async (t) => {
  resetCommandChecks();
  const puts = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/users/@me/guilds")) {
      return new Response(JSON.stringify([{ id: "main", name: "Main" }, { id: "fresh", name: "New" }, { id: "broken", name: "Broken" }]));
    }
    const guild = u.match(/guilds\/(\w+)\/commands/)[1];
    if (guild === "broken") return new Response("Missing Access", { status: 403 });
    if (init.method === "PUT") { puts.push(guild); return new Response("[]"); }
    return new Response("[]");   // Discord has no commands for this server yet
  });
  t.mock.method(console, "error", () => {});
  const out = await ensureAllGuilds("token", "app", "main", COMMANDS, 1e9);
  assert.deepEqual(out, { main: "synced", fresh: "synced", broken: "failed" });
  assert.deepEqual(puts, ["main", "fresh"]);
});

test("the all-server check also runs at most every ten minutes", async (t) => {
  resetCommandChecks();
  let listed = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/users/@me/guilds")) { listed++; return new Response("[]"); }
    return new Response("[]");
  });
  await ensureAllGuilds("t", "app", null, COMMANDS, 1e9);
  await ensureAllGuilds("t", "app", null, COMMANDS, 1e9 + 60_000);
  assert.equal(listed, 1);
});

test("PANEL_FOR_EVERYONE shows /panel to every member and changes nothing else", async () => {
  const { commandList } = await import("../src/commands.js");
  const open = Object.fromEntries(commandList({ panelForEveryone: true }).map((c) => [c.name, c]));
  const usual = Object.fromEntries(commandList().map((c) => [c.name, c]));
  assert.equal(open.panel.default_member_permissions, undefined);
  for (const name of Object.keys(usual).filter((n) => n !== "panel")) {
    assert.deepEqual(open[name], usual[name], `${name} unchanged`);
  }
});
