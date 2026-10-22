/* What a check-in means. No Discord or Google types in here, so it can be tested
   against a stub sheet. */
import { findRow, normName } from "./match.js";

export function eventDate(tz = "America/Los_Angeles", d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}
export const stamp = (tz = "America/Los_Angeles") =>
  new Date().toLocaleString("en-US", { timeZone: tz });

/* ---------- Reading dates and times people type ---------- */

/** "2026-10-23", "10/23/2026" or "10/23" (this year) → "2026-10-23", else null. */
export function parseEventDate(s, tz = "America/Los_Angeles", now = new Date()) {
  const v = String(s ?? "").trim();
  let y, m, d;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (hit) [, y, m, d] = hit.map(Number);
  else if ((hit = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(v))) {
    [m, d] = [Number(hit[1]), Number(hit[2])];
    y = hit[3] ? Number(hit[3].length === 2 ? "20" + hit[3] : hit[3]) : Number(eventDate(tz, now).slice(0, 4));
  } else return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "18:30", "6:30pm", "6:30 PM", "6pm" → minutes after midnight, else null. */
export function parseTime(s) {
  const v = String(s ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  const hit = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm)?$/.exec(v);
  if (!hit) return null;
  let h = Number(hit[1]);
  const min = Number(hit[2] ?? 0);
  if (min > 59) return null;
  if (hit[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (hit[3] === "pm" ? 12 : 0);
  } else if (!hit[2] || h > 23) return null;   // a bare "6" is too ambiguous
  return h * 60 + min;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every date written in a form answer: "10/23", "10/23/2026", "2026-10-23",
    "Thursday, Oct 23rd", or several of them from a checkbox question. A date with no
    year gets the one that puts it closest to now, so a December signup for a January
    event lands in the right year. */
export function datesIn(text, tz = "America/Los_Angeles", now = new Date()) {
  const s = String(text ?? "");
  const today = eventDate(tz, now);
  const thisYear = Number(today.slice(0, 4));
  const out = new Set();
  const add = (y, m, d) => {
    if (y === null) {
      const near = [thisYear - 1, thisYear, thisYear + 1]
        .map((yy) => ({ yy, gap: Math.abs(Date.UTC(yy, m - 1, d) - Date.parse(today)) }))
        .sort((a, b) => a.gap - b.gap)[0];
      y = near.yy;
    }
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() === m - 1 && t.getUTCDate() === d) {
      out.add(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  };
  for (const h of s.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) add(+h[1], +h[2], +h[3]);
  for (const h of s.matchAll(/(?<![\d/-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) {
    add(h[3] ? Number(h[3].length === 2 ? "20" + h[3] : h[3]) : null, +h[1], +h[2]);
  }
  for (const h of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi)) {
    add(h[3] ? +h[3] : null, MONTHS.indexOf(h[1].toLowerCase()) + 1, +h[2]);
  }
  return out;
}

export const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/* ---------- The schedule ----------

   Times are compared as local wall-clock minutes encoded with Date.UTC, so "6:30 PM
   in Los Angeles" never has to become a real instant and daylight saving cannot
   shift it. An event is open for check-in from cfg.opensMinutes before its start
   until its end; an end earlier than the start means it runs past midnight. */

function wallNow(tz, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}
const wallAt = (date, minutes) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, minutes);
};
const fmt = (ms, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(ms));
const fmtDay = (ms) => fmt(ms, { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ms) => fmt(ms, { hour: "numeric", minute: "2-digit" });

/** Sheet rows from the Events tab → events. Lenient, because an organizer may have
    typed into that tab by hand; rows that do not parse are skipped. */
export function parseEvents(rows, cfg, now = new Date()) {
  return rows.map((r) => ({
    date: parseEventDate(r[0], cfg.tz, now),
    start: parseTime(r[1]),
    end: parseTime(r[2]),
    tab: String(r[3] ?? "").trim(),
    location: String(r[6] ?? "").trim(),
    _line: r._line
  })).filter((e) => e.date && e.start !== null && e.end !== null);
}

function timed(ev, cfg) {
  const start = wallAt(ev.date, ev.start);
  const end = wallAt(ev.date, ev.end > ev.start ? ev.end : ev.end + 24 * 60);
  return { ev, start, end, opens: start - cfg.opensMinutes * 60000 };
}

/** The event open for check-in now, the next one, and the last one that ended. */
export function schedule(cfg, now = new Date()) {
  const t = wallNow(cfg.tz, now);
  const list = (cfg.events || []).map((e) => timed(e, cfg)).sort((a, b) => a.start - b.start);
  return {
    t, list,
    active: list.find((x) => t >= x.opens && t < x.end) || null,
    next: list.find((x) => x.opens > t) || null,
    last: [...list].reverse().find((x) => x.end <= t) || null
  };
}

/** The event organizer tools and the attendance list mean: the open one, else one
    that ended within the last 12 hours, else the next, else the last. */
export function currentEvent(cfg, now = new Date()) {
  const s = schedule(cfg, now);
  if (s.active) return s.active;
  if (s.last && s.t - s.last.end < 12 * 3600000) return s.last;
  return s.next || s.last;
}

/** A Google Maps link pasted as is, or an address turned into a Maps search, as a
    Discord link that does not unfurl into a big preview. Empty string when unset. */
export function locationLink(loc) {
  const s = String(loc ?? "").replace(/[<>]/g, "").trim();
  if (!s) return "";
  if (/^https?:\/\/\S+$/i.test(s)) return `📍 [Map](<${s}>)`;
  const label = s.replace(/([\[\]*_~`|\\])/g, "\\$1");
  return `📍 [${label}](<https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}>)`;
}
const where = (x) => (x.ev.location ? ` · ${locationLink(x.ev.location)}` : "");

export function describe(x) {
  const day = fmtDay(x.start);
  const opensDay = fmtDay(x.opens);
  return {
    when: `${day}, ${fmtTime(x.start)} to ${fmtTime(x.end)}`,
    opens: opensDay === day ? fmtTime(x.opens) : `${fmtTime(x.opens)} on ${opensDay}`
  };
}

/** The date check-ins are filed under: the current event's, else today. */
const dayOf = (cfg, now) => currentEvent(cfg, now)?.ev.date || eventDate(cfg.tz, now);

/** Point the sheet at the current event's signup tab. Call before reading signups. */
export function applyEvents(cfg, events, now = new Date()) {
  cfg.events = events;
  const cur = currentEvent(cfg, now);
  if (cur?.ev.tab) cfg.signupTab = cur.ev.tab;
  return cfg;
}

/** One form serves every event, so each signup says which date it is for. These are
    the rows for `date`. A tab without that column (an older per-event form) counts
    every row, so those tabs keep working. */
/** COL_EVENT can name several columns, split by |, for a form whose event question
    was reworded: old answers sit under the old header, new ones under the new. */
export const eventCols = (cfg) => String(cfg.colEvent || "").split("|").map((c) => c.trim()).filter(Boolean);

export function rowsFor(header, rows, cfg, date, now = new Date()) {
  const cols = eventCols(cfg).filter((c) => header.includes(c));
  if (!cols.length) return { rows, byDate: false };
  return { rows: rows.filter((r) => cols.some((c) => datesIn(r[c], cfg.tz, now).has(date))), byDate: true };
}

const signUpHint = (cfg) => (cfg.formUrl ? ` Sign up here: <${cfg.formUrl}>` : "");

/* ---------- Member check-in ---------- */

export async function checkIn(sheet, cfg, who, now = new Date()) {
  const s = schedule(cfg, now);
  if (!s.active) {
    if (s.next) {
      const d = describe(s.next);
      return `Check-in is not open right now. The next event is **${d.when}**, and check-in opens at **${d.opens}**.` +
        (s.next.ev.location ? `\n${locationLink(s.next.ev.location)}` : "");
    }
    return "Check-in is not open: no upcoming events are scheduled. An organizer can add one with `/event-add`.";
  }

  const date = s.active.ev.date;
  const { header, rows: all } = await sheet.readSignups();
  if (!header.length) return "The signup sheet looks empty. Ping an organizer.";
  for (const need of [cfg.colName, cfg.colDiscord]) {
    if (!header.includes(need)) {
      return `The signup tab has no **${need}** column. An organizer needs to fix the column names in the bot's settings.`;
    }
  }

  const cols = { name: cfg.colName, discord: cfg.colDiscord, verifiedId: cfg.colVerifiedId };
  const { rows, byDate } = rowsFor(header, all, cfg, date, now);
  const hit = findRow(rows, who, cols);

  // Signed up, just not for tonight: say that, rather than "no signup found".
  if (hit.status === "none" && byDate && findRow(all, who, cols).status !== "none") {
    return `You are signed up, but not for the **${describe(s.active).when}** event.` +
      `${signUpHint(cfg)}\n\nOr ask an organizer to run \`/checkin-for\` for you.`;
  }

  if (hit.status === "ambiguous") {
    return `Found ${hit.rows.length} signup rows that all point at your account, so I will not guess which one is yours. An organizer can clean that up and you can try again.`;
  }

  if (hit.status === "none") {
    const near = (hit.rows || []).map((r) => r[cfg.colName]).filter(Boolean);
    let t = `I could not find a signup for you.\n\nYour Discord is **${who.username}** (ID \`${who.id}\`). The sheet matches on what you typed in the Discord box on the form, so if you wrote something else there, that is the mismatch.`;
    if (near.length) {
      t += `\n\nThere ${near.length === 1 ? "is a signup" : "are signups"} under **${near.join("**, **")}**, but ${near.length === 1 ? "its" : "their"} Discord box does not point at your account, so I cannot safely use ${near.length === 1 ? "it" : "them"}.`;
    }
    return t + `\n\nAsk an organizer to run \`/checkin-for\` for you, or fill in the form and try again.${signUpHint(cfg)}`;
  }

  const row = hit.row;
  await sheet.ensureAttendanceTab();
  const seen = await sheet.alreadyIn(date);
  if (seen.has(who.id)) {
    return `You are already checked in for tonight as **${row[cfg.colName] || who.username}**. Nothing more to do.`;
  }

  await sheet.markRow(header, row._line, { checkedValue: date, discordId: who.id });
  await sheet.logAttendance([
    stamp(cfg.tz), date, row[cfg.colName] || who.username, who.id, who.username, hit.by, row._line, ""
  ]);
  return `You are checked in for tonight as **${row[cfg.colName] || who.username}**.` +
    (hit.by === "handle"
      ? `\n\nI matched you by your Discord handle and have saved your account ID to the sheet, so next event is instant.`
      : "");
}

export async function amIIn(sheet, cfg, who, now = new Date()) {
  await sheet.ensureAttendanceTab();
  const seen = await sheet.alreadyIn(dayOf(cfg, now));
  return seen.has(who.id)
    ? "Yes, you are checked in for tonight."
    : "Not yet. Hit **Check in** on the panel.";
}

/** Every upcoming event, ticked or crossed by whether this member signed up for it.
    Same matching as check-in: their account ID or Discord username, never a name. */
export async function mySignups(sheet, cfg, who, now = new Date()) {
  const s = schedule(cfg, now);
  const upcoming = s.list.filter((x) => x.end > s.t).slice(0, 10);
  if (!upcoming.length) return `No upcoming events are scheduled yet.${signUpHint(cfg)}`;

  // Events normally share one form's tab; read each tab once.
  const tabs = new Map();
  const previousTab = cfg.signupTab;
  try {
    for (const x of upcoming) {
      const tab = x.ev.tab || cfg.defaultTab;
      if (!tabs.has(tab)) {
        cfg.signupTab = tab;
        tabs.set(tab, await sheet.readSignups());
      }
    }
  } finally {
    cfg.signupTab = previousTab;
  }

  const cols = { name: cfg.colName, discord: cfg.colDiscord, verifiedId: cfg.colVerifiedId };
  let yes = 0;
  const lines = upcoming.map((x) => {
    const { header, rows: all } = tabs.get(x.ev.tab || cfg.defaultTab);
    const { rows } = rowsFor(header, all, cfg, x.ev.date, now);
    const signed = findRow(rows, who, cols).status !== "none";
    if (signed) yes++;
    return `${signed ? "✅" : "❌"} **${describe(x).when}**${x === s.active ? " · check-in open now" : ""}${where(x)}`;
  });

  const foundAnywhere = [...tabs.values()].some(({ rows }) => findRow(rows, who, cols).status !== "none");
  let tail;
  if (!foundAnywhere) {
    tail = `I could not find any signup under your Discord username **${who.username}**. ` +
      `If you did sign up, check the username you typed on the form.${signUpHint(cfg)}`;
  } else if (yes < upcoming.length) {
    tail = `Want to come to more?${signUpHint(cfg)}`;
  } else {
    tail = "You are signed up for everything coming up.";
  }
  return `**Your signups**\n${lines.join("\n")}\n\n${tail}`;
}

/* ---------- Organizer tools ---------- */

/** The signup row an organizer means: by name if given, else by the member's account. */
function pickRow(rows, cfg, { target, name }) {
  if (name) {
    const want = normName(name);
    const exact = rows.filter((r) => normName(r[cfg.colName]) === want);
    if (exact.length === 1) return { row: exact[0] };
    const loose = rows.filter((r) => normName(r[cfg.colName]).includes(want));
    if (loose.length === 1) return { row: loose[0] };
    return {
      error: exact.length > 1 || loose.length > 1
        ? `More than one signup matches "${name}". Use the exact name as it appears on the sheet.`
        : `No signup found under "${name}".`
    };
  }
  if (target) {
    const cols = { name: cfg.colName, discord: cfg.colDiscord, verifiedId: cfg.colVerifiedId };
    const hit = findRow(rows, target, cols);
    if (hit.status !== "matched") {
      return { error: `No signup row points at ${target.username}. Pass \`name:\` as well to say which row is theirs.` };
    }
    return { row: hit.row };
  }
  return { error: "Give me a `member`, a `name`, or both." };
}

/** Find the row among this event's signups; failing that, among everyone's, and say
    so, because an organizer may knowingly check in somebody who signed up for
    another date. */
function pickForEvent(header, all, cfg, date, who, now) {
  const { rows, byDate } = rowsFor(header, all, cfg, date, now);
  const first = pickRow(rows, cfg, who);
  if (!first.error || !byDate) return { ...first, note: "" };
  const wider = pickRow(all, cfg, who);
  return wider.error ? first : { ...wider, note: " (their signup is for a different date)" };
}

/** Organizer check-in. Works outside the window too: walk-ins and fixes. */
export async function checkInFor(sheet, cfg, { target, name, by }, now = new Date()) {
  const date = dayOf(cfg, now);
  const { header, rows } = await sheet.readSignups();
  const { row, error, note } = pickForEvent(header, rows, cfg, date, { target, name }, now);
  if (error) return error;

  await sheet.ensureAttendanceTab();
  if ((await sheet.checkinsFor(date)).has(String(row._line))) {
    return `**${row[cfg.colName]}** is already checked in for ${date}. Nothing more to do.`;
  }

  await sheet.markRow(header, row._line, { checkedValue: date, discordId: target ? target.id : "" });
  await sheet.logAttendance([
    stamp(cfg.tz), date, row[cfg.colName], target ? target.id : "", target ? target.username : "",
    "organizer", row._line, `added by ${by}`
  ]);
  return `Checked in **${row[cfg.colName]}** for ${date}${note}.`;
}

/** Undo a check-in. The log stays append-only: an "undo" row cancels the earlier
    one, so the history of what happened is kept. */
export async function uncheck(sheet, cfg, { target, name, by }, now = new Date()) {
  const date = dayOf(cfg, now);
  const { header, rows } = await sheet.readSignups();
  const { row, error } = pickForEvent(header, rows, cfg, date, { target, name }, now);
  if (error) return error;

  await sheet.ensureAttendanceTab();
  if (!(await sheet.checkinsFor(date)).has(String(row._line))) {
    return `**${row[cfg.colName]}** is not checked in for ${date}, so there is nothing to undo.`;
  }

  const id = target?.id || String(row[cfg.colVerifiedId] ?? "").trim();
  await sheet.markRow(header, row._line, { checkedValue: "", discordId: "" });
  await sheet.logAttendance([
    stamp(cfg.tz), date, row[cfg.colName], id, target ? target.username : "", "undo", row._line, `undone by ${by}`
  ]);
  return `Undid the check-in for **${row[cfg.colName]}** on ${date}. They can check in again.`;
}

/** Who is in, from the log rather than the Checked in column: one signup row can
    cover several dates when the form allows picking more than one. */
export async function attendance(sheet, cfg, now = new Date()) {
  const date = dayOf(cfg, now);
  const { header, rows: all } = await sheet.readSignups();
  const { rows } = rowsFor(header, all, cfg, date, now);
  await sheet.ensureAttendanceTab();
  const names = [...(await sheet.checkinsFor(date)).values()].filter(Boolean).sort();
  const body = names.length ? names.map((n, k) => `${k + 1}. ${n}`).join("\n") : "Nobody yet.";
  return `**${names.length} checked in for ${date}**\n` +
    (body.length > 1800 ? body.slice(0, 1800) + "\n…" : body) +
    `\n\n${rows.length} signed up for this date.`;
}

/* ---------- Managing the schedule ---------- */

/** Add an event, or edit the one already on that date. */
export async function addEvent(sheet, cfg, { date, start, end, tab, location, by }, now = new Date()) {
  const d = parseEventDate(date, cfg.tz, now);
  if (!d) return `I could not read the date "${date}". Use something like \`10/23\` or \`2026-10-23\`.`;
  const s = parseTime(start);
  if (s === null) return `I could not read the start time "${start}". Use something like \`6:30pm\` or \`18:30\`.`;
  const e = parseTime(end);
  if (e === null) return `I could not read the end time "${end}". Use something like \`9:30pm\` or \`21:30\`.`;
  if (e === s) return "The start and end times are the same.";

  const useTab = String(tab ?? "").trim() || cfg.defaultTab;

  // Make sure the tab is there and has the columns check-in needs.
  const previousTab = cfg.signupTab;
  cfg.signupTab = useTab;
  let signups, byDate;
  try {
    const { header, rows } = await sheet.readSignups();
    const missing = [cfg.colName, cfg.colDiscord].filter((c) => !header.includes(c));
    if (!header.length || missing.length) {
      return `The tab **${useTab}** is missing the ${missing.length ? missing.map((c) => `**${c}**`).join(" and ") : "header"} column. Nothing was changed.`;
    }
    ({ rows: { length: signups }, byDate } = rowsFor(header, rows, cfg, d, now));
  } catch (err) {
    if (/Unable to parse range/i.test(String(err.message))) {
      return `There is no tab named **${useTab}** in the signup sheet. Check the spelling. Nothing was changed.`;
    }
    throw err;
  } finally {
    cfg.signupTab = previousTab;
  }

  const existing = (cfg.events || []).find((x) => x.date === d);
  // Left blank, an edit keeps the location it had; "none" clears it.
  const typed = String(location ?? "").trim();
  const loc = /^(none|clear|-)$/i.test(typed) ? "" : typed || existing?.location || "";
  // The usual tab is stored blank, so renaming SIGNUP_TAB later carries every event along.
  const savedTab = useTab === cfg.defaultTab ? "" : useTab;
  await sheet.writeEvent(existing ? existing._line : null, [d, hhmm(s), hhmm(e), savedTab, "", by || "", loc]);

  const x = timed({ date: d, start: s, end: e }, cfg);
  const desc = describe(x);
  return `${existing ? "Updated" : "Scheduled"} **${desc.when}**.\n` +
    (loc ? `${locationLink(loc)}\n` : "") +
    `Check-in opens at **${desc.opens}** and closes when the event ends.\n` +
    (byDate
      ? `${signups} signed up for this date so far.`
      : `Heads up: the **${useTab}** tab has no ${eventCols(cfg).map((c) => `**${c}**`).join(" or ")} column, so every signup there counts for this event.`) +
    (x.end <= schedule(cfg, now).t ? `\n\nHeads up: that event is already over.` : "");
}

export async function removeEvent(sheet, cfg, { date }, now = new Date()) {
  const d = parseEventDate(date, cfg.tz, now);
  if (!d) return `I could not read the date "${date}". Use something like \`10/23\` or \`2026-10-23\`.`;
  const hits = (cfg.events || []).filter((x) => x.date === d);
  if (!hits.length) return `There is no event scheduled on ${d}.`;
  for (const h of hits) await sheet.clearEvent(h._line);
  return `Removed the event on **${describe(timed(hits[0], cfg)).when}**. Check-ins already recorded for it stay on the sheet.`;
}

/** What members see under /events and the Events button. */
export function listEvents(cfg, now = new Date()) {
  const s = schedule(cfg, now);
  const upcoming = s.list.filter((x) => x.end > s.t).slice(0, 10);
  const link = cfg.formUrl ? `\n\nSign up for any of them: [signup form](<${cfg.formUrl}>)` : "";
  if (!upcoming.length) return `No upcoming events are scheduled yet.`;
  const lines = upcoming.map((x) => {
    const d = describe(x);
    const state = x === s.active ? "check-in **open now**" : `check-in opens ${d.opens}`;
    return `**${d.when}**, ${state}${where(x)}`;
  });
  return `**Upcoming events**\n${lines.join("\n")}${link}`;
}
