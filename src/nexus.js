/* Nexus Points: the club currency, kept on the Nexus Ledger tab of the Triton MMR
   sheet (one row per award or redemption, so a balance is the sum of a player's
   rows). That sheet is shared as "anyone with the link can view", so it is read
   through Google's public CSV export and needs no service account access. */
import { findRow, normName } from "./match.js";

/** The ledger as CSV. Google answers a missing tab with the first one, so the
    caller checks the header before trusting it. */
export async function fetchLedger(sheetId, tab = "Nexus Ledger") {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}` +
    `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`the MMR sheet answered ${res.status}`);
  return res.text();
}

/** Plain CSV with quoted fields, as Google writes it. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Ledger rows as objects, or null when the CSV is not the ledger. */
export function ledgerRows(csv) {
  const [head, ...body] = parseCsv(csv);
  if (!head) return [];
  const at = (name) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const iDate = at("date"), iPlayer = at("player"), iPoints = at("points"), iReason = at("reason");
  if (iPlayer < 0 || iPoints < 0 || at("rating") >= 0) return null;
  return body.map((r) => ({
    date: (r[iDate] || "").trim(), player: (r[iPlayer] || "").trim(),
    points: Number(r[iPoints]) || 0, reason: (r[iReason] || "").trim()
  }));
}

/** A player's balance and their latest entries. A balance never goes below zero. */
export function balanceFor(rows, name) {
  const key = normName(name);
  const mine = rows.filter((r) => normName(r.player) === key);
  const total = Math.round(mine.reduce((a, r) => a + r.points, 0) * 10) / 10;
  return { balance: Math.max(0, total), entries: mine.slice(-5).reverse() };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** /nexus: the caller's balance. They are found on the signup sheet the same way
    check-in finds them (account ID, or an unambiguous Discord username, never a
    typed name), and that row's name is what the ledger is keyed on. */
export async function myNexus(sheet, cfg, who, getLedger = fetchLedger) {
  if (!cfg.mmrSheetId) return "Nexus Points are not set up on this bot yet (MMR_SHEET_ID is missing).";
  const { rows: signups } = await sheet.readSignups();
  const cols = { name: cfg.colName, discord: cfg.colDiscord, verifiedId: cfg.colVerifiedId };
  const hit = findRow(signups, who, cols);
  if (hit.status !== "matched") {
    return `I could not find a signup under your Discord username **${who.username}**, ` +
      "so I do not know which name your Nexus Points are under. Sign up for an event with that username first.";
  }
  const name = String(hit.row[cfg.colName] || "").trim();
  const rows = ledgerRows(await getLedger(cfg.mmrSheetId));
  if (rows === null) return "No Nexus Points have been handed out yet. They start with the next event.";
  const { balance, entries } = balanceFor(rows, name);
  const lines = entries.map((e) => `${signed(e.points)} · ${e.reason || "Nexus Points"}${e.date ? ` (${e.date})` : ""}`);
  return `**${name}: ${balance} Nexus Point${balance === 1 ? "" : "s"}**` +
    (lines.length ? `\nLatest:\n${lines.join("\n")}` : "\nNone yet. You earn them by playing at events.") +
    (cfg.rankingsUrl ? `\nFull standings: ${cfg.rankingsUrl}` : "");
}
