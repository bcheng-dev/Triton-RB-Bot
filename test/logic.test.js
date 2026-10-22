import test from "node:test";
import assert from "node:assert/strict";
import { checkIn, amIIn, checkInFor, uncheck, attendance, eventDate } from "../src/logic.js";

const TODAY = eventDate("America/Los_Angeles");
const cfg = {
  tz: "America/Los_Angeles",
  signupTab: "Form Responses 1", attendanceTab: "Attendance",
  colName: "Name", colDiscord: "Discord",
  colVerifiedId: "Discord ID (verified)", colChecked: "Checked in",
  opensMinutes: 30,
  // An event running all of today (midnight to midnight), so check-in is open.
  events: [{ date: TODAY, start: 0, end: 0 }]
};

/** A spreadsheet that lives in memory and records what was written to it. */
function stubSheet(rows, header = ["Name", "Discord"]) {
  const log = [];
  return {
    marks: [], appended: [], log,
    async readSignups() {
      return { header: header.slice(), rows: rows.map((r, i) => ({ _line: i + 2, ...r })) };
    },
    async ensureAttendanceTab() { log.push("ensureTab"); },
    async alreadyIn(date) {
      const seen = new Set();
      this.appended.filter((a) => a[1] === date).forEach((a) => (a[5] === "undo" ? seen.delete(a[3]) : seen.add(a[3])));
      return seen;
    },
    async checkinsFor(date) {
      const out = new Map();
      this.appended.filter((a) => a[1] === date)
        .forEach((a) => (a[5] === "undo" ? out.delete(String(a[6])) : out.set(String(a[6]), a[2])));
      return out;
    },
    async markRow(h, line, p) { this.marks.push({ line, ...p }); },
    async logAttendance(row) { this.appended.push(row); }
  };
}

test("a clean check-in ticks the row and logs attendance", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain" }]);
  const out = await checkIn(s, cfg, { id: "284613901234567890", username: "arimain" });
  assert.match(out, /checked in for tonight as \*\*Ari\*\*/);
  assert.deepEqual(s.marks, [{ line: 2, checkedValue: TODAY, discordId: "284613901234567890" }]);
  assert.equal(s.appended.length, 1);
  assert.equal(s.appended[0][1], TODAY);
  assert.equal(s.appended[0][2], "Ari");
  assert.equal(s.appended[0][3], "284613901234567890");
  assert.equal(s.appended[0][5], "handle");
  assert.match(out, /saved your account ID/);   // tells them it gets faster next time
});

test("a second click is refused, not double-logged", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain" }]);
  await checkIn(s, cfg, { id: "284613901234567890", username: "arimain" });
  const again = await checkIn(s, cfg, { id: "284613901234567890", username: "arimain" });
  assert.match(again, /already checked in/);
  assert.equal(s.appended.length, 1, "must not append a second attendance row");
  assert.equal(s.marks.length, 1, "must not re-stamp the signup row");
});

test("an ID match does not nag about saving the ID", async () => {
  const s = stubSheet([{ Name: "Luke Dinh", Discord: "539284017654321098" }]);
  const out = await checkIn(s, cfg, { id: "539284017654321098", username: "lukey" });
  assert.match(out, /Luke Dinh/);
  assert.doesNotMatch(out, /saved your account ID/);
  assert.equal(s.appended[0][5], "id");
});

test("no signup tells them exactly what the bot saw", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain" }]);
  const out = await checkIn(s, cfg, { id: "771002938475610293", username: "stranger" });
  assert.match(out, /could not find a signup/);
  assert.match(out, /\*\*stranger\*\*/);
  assert.match(out, /771002938475610293/);
  assert.equal(s.appended.length, 0);
  assert.equal(s.marks.length, 0);
});

test("a name lookalike is surfaced but never checked in", async () => {
  const s = stubSheet([{ Name: "Alice Chen", Discord: "someoneelse" }]);
  const out = await checkIn(s, cfg, { id: "771002938475610293", username: "ac2027", globalName: "Alice Chen" });
  assert.match(out, /signup under \*\*Alice Chen\*\*/);
  assert.match(out, /cannot safely use/);
  assert.equal(s.marks.length, 0, "a name match must never write");
});

test("duplicate rows are refused rather than guessed", async () => {
  const s = stubSheet([{ Name: "A", Discord: "lucas" }, { Name: "B", Discord: "@lucas" }]);
  const out = await checkIn(s, cfg, { id: "612938475610293847", username: "lucas" });
  assert.match(out, /2 signup rows/);
  assert.equal(s.marks.length, 0);
});

test("a missing Discord column is reported as a config problem", async () => {
  const s = stubSheet([{ Name: "Ari" }], ["Name"]);
  const out = await checkIn(s, cfg, { id: "1", username: "ari" });
  assert.match(out, /no \*\*Discord\*\* column/);
});

test("an empty sheet does not crash", async () => {
  const s = { async readSignups() { return { header: [], rows: [] }; } };
  assert.match(await checkIn(s, cfg, { id: "1", username: "x" }), /looks empty/);
});

test("am I in reflects the log", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain" }]);
  assert.match(await amIIn(s, cfg, { id: "284613901234567890" }), /Not yet/);
  await checkIn(s, cfg, { id: "284613901234567890", username: "arimain" });
  assert.match(await amIIn(s, cfg, { id: "284613901234567890" }), /Yes/);
});

test("organizer override works by name alone, for a walk-in with no account match", async () => {
  const s = stubSheet([{ Name: "Jun-Ting Chiang", Discord: "typo" }]);
  const out = await checkInFor(s, cfg, { target: null, name: "jun ting chiang", by: "brian" });
  assert.match(out, /Checked in \*\*Jun-Ting Chiang\*\*/);
  assert.equal(s.appended[0][5], "organizer");
  assert.match(s.appended[0][7], /added by brian/);
});

test("organizer override refuses an ambiguous name instead of picking one", async () => {
  const s = stubSheet([{ Name: "Alex Kim", Discord: "a" }, { Name: "Alex Kim", Discord: "b" }]);
  const out = await checkInFor(s, cfg, { target: null, name: "Alex Kim", by: "brian" });
  assert.match(out, /More than one signup/);
  assert.equal(s.marks.length, 0);
});

test("organizer override on somebody already in tonight does not double-log", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "a" }]);
  await checkInFor(s, cfg, { target: null, name: "Ari", by: "brian" });
  const out = await checkInFor(s, cfg, { target: null, name: "Ari", by: "brian" });
  assert.match(out, /already checked in/);
  assert.equal(s.marks.length, 1);
  assert.equal(s.appended.length, 1);
});

test("un-checkin undoes your own check-in so you can test again", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain" }], ["Name", "Discord", "Checked in"]);
  const me = { id: "284613901234567890", username: "arimain" };
  await checkIn(s, cfg, me);
  const out = await uncheck(s, cfg, { target: me, name: null, by: "arimain" });
  assert.match(out, /Undid the check-in for \*\*Ari\*\*/);
  assert.deepEqual(s.marks.at(-1), { line: 2, checkedValue: "", discordId: "" });
  assert.equal(s.appended.at(-1)[5], "undo");
  assert.match(await amIIn(s, cfg, me), /Not yet/);
  assert.match(await checkIn(s, cfg, me), /You are checked in/, "can check in again after an undo");
});

test("un-checkin on somebody who is not in changes nothing", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain" }]);
  const out = await uncheck(s, cfg, { target: null, name: "Ari", by: "brian" });
  assert.match(out, /not checked in/);
  assert.equal(s.marks.length, 0);
  assert.equal(s.appended.length, 0);
});

test("attendance counts only tonight, and respects undo", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "a" }, { Name: "Luke", Discord: "b" }, { Name: "Robbie", Discord: "c" }]);
  s.appended.push(
    ["t", TODAY, "Ari", "1", "a", "id", 2, ""],
    ["t", "2020-01-01", "Luke", "2", "b", "id", 3, ""],
    ["t", TODAY, "Robbie", "3", "c", "id", 4, ""],
    ["t", TODAY, "Robbie", "3", "c", "undo", 4, ""]
  );
  const out = await attendance(s, cfg);
  assert.match(out, /\*\*1 checked in/);
  assert.match(out, /1\. Ari/);
  assert.doesNotMatch(out, /Luke|Robbie/);
  assert.match(out, /3 signed up for this date/);
});

/* ---------- One form for every event: signups say which date ---------- */

const EVENT_COL = "Which event(date) are you signing up for?";
const dated = { ...cfg, colEvent: EVENT_COL, formUrl: "https://forms.example/x" };
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

test("check-in only counts signups for tonight's date", async () => {
  const s = stubSheet([
    { Name: "Ari (next week)", Discord: "arimain", [EVENT_COL]: "1/1/2099" },
    { Name: "Ari", Discord: "arimain", [EVENT_COL]: `Event on ${md(TODAY)}` }
  ], ["Name", "Discord", EVENT_COL]);
  const out = await checkIn(s, dated, { id: "1", username: "arimain" });
  assert.match(out, /checked in for tonight as \*\*Ari\*\*/, "two submissions, but only one for tonight");
  assert.equal(s.marks[0].line, 3);
});

test("signed up for another date is told so, with the form link", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain", [EVENT_COL]: "1/1/2099" }], ["Name", "Discord", EVENT_COL]);
  const out = await checkIn(s, dated, { id: "1", username: "arimain" });
  assert.match(out, /signed up, but not for/);
  assert.match(out, /https:\/\/forms\.example\/x/);
  assert.equal(s.marks.length, 0);
});

test("an organizer can still check in somebody who picked another date, and is told", async () => {
  const s = stubSheet([{ Name: "Ari", Discord: "arimain", [EVENT_COL]: "1/1/2099" }], ["Name", "Discord", EVENT_COL]);
  const out = await checkInFor(s, dated, { target: null, name: "Ari", by: "brian" });
  assert.match(out, /Checked in \*\*Ari\*\*.*different date/);
  assert.equal(s.appended.length, 1);
});

test("attendance's signup count is for tonight's date only", async () => {
  const s = stubSheet([
    { Name: "Ari", Discord: "a", [EVENT_COL]: md(TODAY) },
    { Name: "Luke", Discord: "b", [EVENT_COL]: "1/1/2099" }
  ], ["Name", "Discord", EVENT_COL]);
  assert.match(await attendance(s, dated), /1 signed up for this date/);
});
