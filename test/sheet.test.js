import test from "node:test";
import assert from "node:assert/strict";
import { Sheet } from "../src/google.js";

const cfg = {
  signupTab: "Form Responses 1", attendanceTab: "Attendance",
  colVerifiedId: "Discord ID (verified)", colChecked: "Checked in"
};

/** Google, faked at the fetch level, recording every Sheets write. `values` answers
    a read with those rows. */
async function fakeGoogle(t, values = []) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const creds = { client_email: "bot@example.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` };
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    writes.push({ url: decodeURIComponent(String(url)), body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(init.method ? {} : { values }));
  });
  return { creds, writes };
}

test("an organizer check-in without an ID leaves the verified ID cell alone", async (t) => {
  const { creds, writes } = await fakeGoogle(t);
  const sheet = new Sheet(creds, "sheet123", cfg);
  const header = ["Name", "Discord", "Checked in", "Discord ID (verified)"];
  await sheet.markRow(header, 5, { checkedValue: "2026-10-19", discordId: "" });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.data, [{ range: "'Form Responses 1'!C5", values: [["2026-10-19"]] }]);
});

test("a check-in with an ID stamps both cells", async (t) => {
  const { creds, writes } = await fakeGoogle(t);
  const sheet = new Sheet(creds, "sheet123", cfg);
  const header = ["Name", "Discord", "Checked in", "Discord ID (verified)"];
  await sheet.markRow(header, 5, { checkedValue: "2026-10-19", discordId: "284613901234567890" });
  assert.deepEqual(writes[0].body.data.map((d) => d.range), ["'Form Responses 1'!C5", "'Form Responses 1'!D5"]);
  assert.deepEqual(writes[0].body.data[1].values, [["284613901234567890"]]);
});

test("an undo row in the Attendance log cancels the check-in before it", async (t) => {
  const { creds } = await fakeGoogle(t, [
    ["1:00", "2026-10-23", "Ari", "111", "ari", "handle", "2", ""],
    ["1:05", "2026-10-23", "Ari", "111", "ari", "undo", "2", "undone by brian"],
    ["1:06", "2026-10-23", "Luke", "222", "luke", "id", "3", ""],
    ["1:07", "2026-10-16", "Robbie", "333", "robbie", "id", "4", ""]
  ]);
  const seen = await new Sheet(creds, "sheet123", cfg).alreadyIn("2026-10-23");
  assert.deepEqual([...seen], ["222"]);
});

test("re-checking in after an undo counts again", async (t) => {
  const { creds } = await fakeGoogle(t, [
    ["1:00", "2026-10-23", "Ari", "111", "ari", "handle", "2", ""],
    ["1:05", "2026-10-23", "Ari", "111", "ari", "undo", "2", ""],
    ["1:06", "2026-10-23", "Ari", "111", "ari", "id", "2", ""]
  ]);
  const seen = await new Sheet(creds, "sheet123", cfg).alreadyIn("2026-10-23");
  assert.ok(seen.has("111"));
});

test("check-ins for a date are rebuilt from the log by signup row, undo included", async (t) => {
  const { creds } = await fakeGoogle(t, [
    ["1:00", "2026-10-23", "Ari", "111", "ari", "handle", "2", ""],
    ["1:01", "2026-10-23", "Walk-in", "", "", "organizer", "5", "added by brian"],
    ["1:02", "2026-10-23", "Luke", "222", "luke", "id", "3", ""],
    ["1:03", "2026-10-23", "Luke", "222", "", "undo", "3", "undone by brian"],
    ["1:04", "2026-10-16", "Robbie", "333", "robbie", "id", "4", ""]
  ]);
  const got = await new Sheet(creds, "sheet123", cfg).checkinsFor("2026-10-23");
  assert.deepEqual([...got.entries()], [["2", "Ari"], ["5", "Walk-in"]]);
});

/* ---------- Old signup tabs ---------- */

/** Google, faked per tab: `tabs` maps a tab name to its rows (header first). */
async function fakeTabs(t, tabs) {
  const { creds, writes } = await fakeGoogle(t);
  const base = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.startsWith("https://oauth2.googleapis.com/token")) return base(url, init);
    writes.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.includes(":append")) return new Response(JSON.stringify({ updates: { updatedRange: "'New'!A3:F3" } }));
    if (init.method) return new Response("{}");
    const tab = /values\/'(.+?)'/.exec(u)?.[1];
    if (!(tab in tabs)) return new Response("Unable to parse range", { status: 400 });
    return new Response(JSON.stringify({ values: tabs[tab] }));
  });
  return { creds, writes };
}

const multi = {
  ...cfg, signupTab: "New", defaultTab: "New", oldTabs: ["Old", "Gone"],
  colName: "What is your FULL NAME?", colDiscord: "Discord",
  colEvent: "Which event are you signing up for?|Which event(date) are you signing up for?"
};

test("the old form's tab is read too, under the new tab's column names", async (t) => {
  const { creds } = await fakeTabs(t, {
    New: [["Timestamp", "What is your FULL NAME?", "Discord", "Which event are you signing up for?"],
          ["11/12", "Bea", "beab", "11/13"]],
    Old: [["Timestamp", "What is your full name?", "Discord", "Which event(date) are you signing up for?", "Checked in", "Discord ID (verified)"],
          ["10/19", "Ari", "arimain", "Friday, November 13th", "", "111"]]
  });
  const sheet = new Sheet(creds, "sheet123", multi);
  const { header, rows } = await sheet.readSignups();
  assert.deepEqual(rows.map((r) => [r["What is your FULL NAME?"], r._line, !!r._old]), [["Bea", 2, false], ["Ari", "Old!2", true]]);
  assert.ok(header.includes("Which event(date) are you signing up for?"));
  assert.equal(rows[1]["Discord ID (verified)"], "111");
});

test("an old-form signup is copied onto the new tab and checked in there", async (t) => {
  const { creds, writes } = await fakeTabs(t, {
    New: [["Timestamp", "What is your FULL NAME?", "Discord", "Which event are you signing up for?"]],
    Old: [["Timestamp", "What is your full name?", "Discord", "Which event(date) are you signing up for?"],
          ["10/19", "Ari", "arimain", "Friday, November 13th"]]
  });
  const sheet = new Sheet(creds, "sheet123", multi);
  const { header, rows } = await sheet.readSignups();
  const line = await sheet.portRow(rows[0]);
  assert.equal(line, 3);
  const append = writes.find((w) => w.url.includes(":append"));
  assert.match(append.url, /'New'!A1:append/);
  assert.deepEqual(append.body.values, [["10/19", "Ari", "arimain", "Friday, November 13th"]]);

  await sheet.markRow(header, line, { checkedValue: "2026-11-13", discordId: "111" });
  const puts = writes.filter((w) => w.body?.values?.[0]?.[0] === "Checked in" || w.body?.values?.[0]?.[0] === "Discord ID (verified)");
  assert.deepEqual(puts.map((w) => /'(.+?)'!(\w+)/.exec(w.url).slice(1).join("!")), ["New!E1", "New!F1"],
    "Checked in and Discord ID (verified) go after the new tab's last column");
  const batch = writes.find((w) => w.url.includes("values:batchUpdate"));
  assert.deepEqual(batch.body.data.map((d) => d.range), ["'New'!E3", "'New'!F3"]);
});
