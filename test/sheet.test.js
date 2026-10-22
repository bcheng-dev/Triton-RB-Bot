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
