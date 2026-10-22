import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEventDate, parseTime, datesIn, schedule, checkIn,
  addEvent, removeEvent, listEvents, parseEvents, mySignups, locationLink
} from "../src/logic.js";

/** A moment in Los Angeles in October 2026 (PDT, UTC-7). */
const la = (day, h, m = 0) => new Date(Date.UTC(2026, 9, day, h + 7, m));

const base = () => ({
  tz: "America/Los_Angeles", opensMinutes: 30,
  signupTab: "Form Responses 1", defaultTab: "Form Responses 1",
  colName: "Name", colDiscord: "Discord", colVerifiedId: "Discord ID (verified)", colChecked: "Checked in",
  events: []
});
const NIGHT = { date: "2026-10-23", start: 18 * 60 + 30, end: 21 * 60 + 30 };   // 6:30 to 9:30 PM

test("dates people type", () => {
  const now = la(19, 12);
  assert.equal(parseEventDate("10/23", "America/Los_Angeles", now), "2026-10-23");
  assert.equal(parseEventDate("10/23/26"), "2026-10-23");
  assert.equal(parseEventDate("2026-10-23"), "2026-10-23");
  assert.equal(parseEventDate("2026-02-30"), null);
  assert.equal(parseEventDate("next friday"), null);
});

test("times people type, and what the sheet hands back", () => {
  assert.equal(parseTime("6:30pm"), 1110);
  assert.equal(parseTime("6:30 PM"), 1110);
  assert.equal(parseTime("18:30"), 1110);
  assert.equal(parseTime("18:30:00"), 1110);
  assert.equal(parseTime("6pm"), 1080);
  assert.equal(parseTime("12am"), 0);
  assert.equal(parseTime("12pm"), 720);
  assert.equal(parseTime("6"), null, "a bare hour is ambiguous");
  assert.equal(parseTime("25:00"), null);
});

test("the event dates in a form answer, however the form writes them", () => {
  const tz = "America/Los_Angeles";
  const now = la(19, 12);
  const has = (text, ...dates) => assert.deepEqual([...datesIn(text, tz, now)].sort(), dates.sort(), text);
  has("10/23", "2026-10-23");
  has("10/23/2026", "2026-10-23");
  has("2026-10-23", "2026-10-23");
  has("Thursday, Oct 23rd", "2026-10-23");
  has("November 7 (casual)", "2026-11-07");
  has("10/23, 11/7", "2026-10-23", "2026-11-07");        // a checkbox question
  has("1/9", "2027-01-09");                               // no year: the nearest one
  has("10/230");
  has("");
});

test("check-in opens 30 minutes before the start and closes at the end", () => {
  const cfg = { ...base(), events: [NIGHT] };
  assert.equal(schedule(cfg, la(23, 17, 59)).active, null);
  assert.ok(schedule(cfg, la(23, 18, 0)).active);
  assert.ok(schedule(cfg, la(23, 21, 29)).active);
  assert.equal(schedule(cfg, la(23, 21, 30)).active, null);
});

test("an event that runs past midnight stays open until it ends", () => {
  const cfg = { ...base(), events: [{ date: "2026-10-24", start: 22 * 60, end: 60 }] };
  assert.ok(schedule(cfg, la(25, 0, 30)).active);
  assert.equal(schedule(cfg, la(25, 1, 0)).active, null);
});

test("members are told when check-in opens, and nothing is read or written early", async () => {
  const cfg = { ...base(), events: [NIGHT] };
  const sheet = { async readSignups() { throw new Error("must not read the sheet"); } };
  const early = await checkIn(sheet, cfg, { id: "1", username: "ari" }, la(23, 12));
  assert.match(early, /not open right now/);
  assert.match(early, /opens at \*\*6:00 PM\*\*/);
  const none = await checkIn(sheet, base(), { id: "1", username: "ari" }, la(23, 12));
  assert.match(none, /no upcoming events/);
  const after = await checkIn(sheet, cfg, { id: "1", username: "ari" }, la(23, 22));
  assert.match(after, /no upcoming events/);
});

const EVENT_COL = "Which event(date) are you signing up for?";

/** The one form's tab, with signups for two dates, and a record of schedule writes. */
function scheduleSheet(cfg, tabs = { Signups: ["10/23", "10/23", "11/7"], "Old form": null }) {
  return {
    writes: [], cleared: [],
    async readSignups() {
      if (!(cfg.signupTab in tabs)) throw new Error(`sheets 400: Unable to parse range: '${cfg.signupTab}'`);
      const picks = tabs[cfg.signupTab];
      if (!picks) return { header: ["Name", "Discord"], rows: [{ _line: 2 }] };
      return { header: ["Name", "Discord", EVENT_COL], rows: picks.map((d, i) => ({ _line: i + 2, [EVENT_COL]: d })) };
    },
    async writeEvent(line, row) { this.writes.push({ line, row }); },
    async clearEvent(line) { this.cleared.push(line); }
  };
}
const formCfg = () => ({ ...base(), signupTab: "Signups", defaultTab: "Signups", colEvent: EVENT_COL });

test("event-add schedules an event on the one signup form", async () => {
  const cfg = formCfg();
  const s = scheduleSheet(cfg);
  const out = await addEvent(s, cfg, { date: "10/23", start: "6:30pm", end: "9:30pm", by: "brian" }, la(19, 12));
  assert.deepEqual(s.writes, [{ line: null, row: ["2026-10-23", "18:30", "21:30", "Signups", "", "brian", ""] }]);
  assert.match(out, /Scheduled \*\*Fri, Oct 23, 6:30 PM to 9:30 PM\*\*/);
  assert.match(out, /opens at \*\*6:00 PM\*\*/);
  assert.match(out, /2 signed up for this date so far/);
  assert.equal(cfg.signupTab, "Signups", "validation must not leave the tab switched");
});

test("event-add on a date that already has an event edits it", async () => {
  const cfg = { ...formCfg(), events: [{ ...NIGHT, _line: 3 }] };
  const s = scheduleSheet(cfg);
  const out = await addEvent(s, cfg, { date: "10/23", start: "7pm", end: "10pm" }, la(19, 12));
  assert.equal(s.writes[0].line, 3);
  assert.match(out, /^Updated/);
});

test("event-add warns when a tab has no event-date column", async () => {
  const cfg = formCfg();
  const out = await addEvent(scheduleSheet(cfg), cfg, { date: "10/23", start: "6pm", end: "9pm", tab: "Old form" }, la(19, 12));
  assert.match(out, /every signup there counts/);
});

test("event-add refuses bad input and writes nothing", async () => {
  const cfg = formCfg();
  const s = scheduleSheet(cfg);
  assert.match(await addEvent(s, cfg, { date: "10/23", start: "soon", end: "9pm" }), /could not read the start time/);
  assert.match(await addEvent(s, cfg, { date: "10/23", start: "6pm", end: "6pm" }), /same/);
  assert.match(await addEvent(s, cfg, { date: "someday", start: "6pm", end: "9pm" }), /could not read the date/);
  assert.match(await addEvent(s, cfg, { date: "10/23", start: "6pm", end: "9pm", tab: "Nope" }), /no tab named \*\*Nope\*\*/);
  assert.equal(s.writes.length, 0);
});

test("event-remove clears that event's row", async () => {
  const cfg = { ...formCfg(), events: [{ ...NIGHT, _line: 4 }] };
  const s = scheduleSheet(cfg);
  assert.match(await removeEvent(s, cfg, { date: "10/23" }, la(19, 12)), /Removed/);
  assert.deepEqual(s.cleared, [4]);
  assert.match(await removeEvent(s, cfg, { date: "11/1" }, la(19, 12)), /no event scheduled/);
});

test("the events list shows what is coming, what is open, and the form link", () => {
  const cfg = {
    ...base(), formUrl: "https://forms.gle/x",
    events: parseEvents([
      Object.assign(["2026-10-16", "18:30", "21:30", "Signups"], { _line: 2 }),
      Object.assign(["2026-10-23", "6:30 PM", "9:30 PM", "Signups"], { _line: 3 }),
      Object.assign(["10/30/2026", "18:30", "21:30", "Signups"], { _line: 4 }),
      Object.assign(["someday", "18:30", "21:30"], { _line: 5 })
    ], { tz: "America/Los_Angeles" })
  };
  const out = listEvents(cfg, la(23, 18, 15));
  assert.doesNotMatch(out, /Oct 16/, "past events are hidden");
  assert.match(out, /Oct 23.*open now/);
  assert.match(out, /Oct 30.*check-in opens 6:00 PM/);
  assert.match(out, /\(<https:\/\/forms\.gle\/x>\)/);
  assert.equal(cfg.events.length, 3, "unreadable rows are skipped");
});

/* ---------- My signups ---------- */

function signupSheet(cfg, rows) {
  return {
    async readSignups() {
      return { header: ["Name", "Discord", EVENT_COL], rows: rows.map((r, i) => ({ _line: i + 2, ...r })) };
    }
  };
}
const twoEvents = () => ({
  ...formCfg(), formUrl: "https://forms.gle/x",
  events: [NIGHT, { date: "2026-11-07", start: 11 * 60, end: 16 * 60 }]
});
const me = { id: "284613901234567890", username: "arimain" };

test("my signups ticks the events you signed up for and crosses the rest", async () => {
  const cfg = twoEvents();
  const s = signupSheet(cfg, [
    { Name: "Ari", Discord: "arimain", [EVENT_COL]: "Friday, October 23" },
    { Name: "Luke", Discord: "luke", [EVENT_COL]: "Saturday, November 7" }
  ]);
  const out = await mySignups(s, cfg, me, la(19, 12));
  assert.match(out, /✅ \*\*Fri, Oct 23/);
  assert.match(out, /❌ \*\*Sat, Nov 7/);
  assert.match(out, /Want to come to more\?.*forms\.gle\/x/);
});

test("my signups says so when you are down for everything", async () => {
  const cfg = twoEvents();
  const s = signupSheet(cfg, [{ Name: "Ari", Discord: "@arimain", [EVENT_COL]: "Friday, October 23, Saturday, November 7" }]);
  const out = await mySignups(s, cfg, me, la(19, 12));
  assert.doesNotMatch(out, /❌/);
  assert.match(out, /signed up for everything/);
});

test("my signups with no match anywhere names the username it looked for", async () => {
  const cfg = twoEvents();
  const out = await mySignups(signupSheet(cfg, [{ Name: "Luke", Discord: "luke", [EVENT_COL]: "10/23" }]), cfg, me, la(19, 12));
  assert.match(out, /could not find any signup under your Discord username \*\*arimain\*\*/);
  assert.equal((out.match(/❌/g) || []).length, 2);
});

test("my signups never counts a real-name lookalike", async () => {
  const cfg = twoEvents();
  const s = signupSheet(cfg, [{ Name: "Ari Main", Discord: "somebodyelse", [EVENT_COL]: "10/23" }]);
  const out = await mySignups(s, cfg, { ...me, globalName: "Ari Main" }, la(19, 12));
  assert.doesNotMatch(out, /✅/);
});

test("my signups skips events that are over", async () => {
  const cfg = twoEvents();
  const out = await mySignups(signupSheet(cfg, []), cfg, me, la(25, 12));
  assert.doesNotMatch(out, /Oct 23/);
  assert.match(out, /Nov 7/);
});

/* ---------- Locations ---------- */

test("event-add saves a location, and an edit without one keeps it", async () => {
  const cfg = formCfg();
  const s = scheduleSheet(cfg);
  const out = await addEvent(s, cfg, { date: "10/23", start: "6:30pm", end: "9:30pm", location: "Price Center East, La Jolla", by: "brian" }, la(19, 12));
  assert.equal(s.writes[0].row[6], "Price Center East, La Jolla");
  assert.match(out, /📍 \[Price Center East, La Jolla\]\(<https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Price%20Center%20East%2C%20La%20Jolla>\)/);

  const cfg2 = { ...formCfg(), events: [{ ...NIGHT, location: "Geisel", _line: 3 }] };
  const s2 = scheduleSheet(cfg2);
  await addEvent(s2, cfg2, { date: "10/23", start: "7pm", end: "10pm" }, la(19, 12));
  assert.equal(s2.writes[0].row[6], "Geisel");
  await addEvent(s2, cfg2, { date: "10/23", start: "7pm", end: "10pm", location: "none" }, la(19, 12));
  assert.equal(s2.writes[1].row[6], "");
});

test("a pasted Google Maps link is used as is, and the events list shows it", () => {
  assert.equal(locationLink("https://maps.app.goo.gl/abc123"), "📍 [Map](<https://maps.app.goo.gl/abc123>)");
  assert.equal(locationLink(""), "");
  const cfg = {
    ...base(),
    events: parseEvents([
      Object.assign(["2026-10-23", "18:30", "21:30", "Signups", "", "brian", "https://maps.app.goo.gl/abc123"], { _line: 2 }),
      Object.assign(["2026-10-30", "18:30", "21:30", "Signups"], { _line: 3 })
    ], { tz: "America/Los_Angeles" })
  };
  const out = listEvents(cfg, la(20, 12));
  assert.match(out, /Oct 23.*\[Map\]\(<https:\/\/maps\.app\.goo\.gl\/abc123>\)/);
  assert.doesNotMatch(out.split("\n").find((l) => l.includes("Oct 30")), /📍/);
});
