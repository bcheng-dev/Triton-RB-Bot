import test from "node:test";
import assert from "node:assert/strict";
import { postPanel, syncAllGuilds } from "../src/discord.js";

async function panel(t, links) {
  let sent;
  t.mock.method(globalThis, "fetch", async (url, init) => { sent = JSON.parse(init.body); return new Response("{}"); });
  await postPanel("token", "channel", 30, links);
  return sent.components.map((row) => row.components.map((b) => b.label));
}

test("the panel puts actions on one row and form links on a second", async (t) => {
  const rows = await panel(t, {
    signupUrl: "https://forms.example/signup",
    feedbackUrl: "https://forms.example/feedback",
    rankingsUrl: "https://standings.example/"
  });
  assert.deepEqual(rows, [["Check in", "Am I in?", "Events", "My signups"], ["Sign up", "Feedback", "Rankings"]]);
  assert.ok(rows.every((r) => r.length <= 5), "Discord allows at most five buttons in a row");
});

test("form link buttons are left out when no link is set", async (t) => {
  assert.deepEqual(await panel(t, { feedbackUrl: "https://forms.example/feedback" }),
    [["Check in", "Am I in?", "Events", "My signups"], ["Feedback"]]);
  assert.equal((await panel(t, {})).length, 1);
});

test("/panel's command sync reaches every server the bot is in", async (t) => {
  const puts = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).includes("/users/@me/guilds")) {
      return new Response(JSON.stringify([{ id: "111", name: "Main" }, { id: "222", name: "Test" }, { id: "333", name: "Broken" }]));
    }
    puts.push(String(url).match(/guilds\/(\d+)\/commands/)[1]);
    return String(url).includes("/333/") ? new Response("Missing Access", { status: 403 }) : new Response("[]");
  });
  t.mock.method(console, "error", () => {});
  const out = await syncAllGuilds("token", "app", [{ name: "checkin" }]);
  assert.deepEqual(puts, ["111", "222", "333"]);
  assert.deepEqual(out, { synced: 2, failed: ["Broken"] });
});
