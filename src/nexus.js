/* Nexus Points: the club currency, kept on the Nexus Ledger tab of the Triton MMR
   sheet, one row per award or redemption, so a balance is the sum of a player's rows.
   The Nexus Shop tab of the same sheet lists what points can be spent on.

   With the sheet shared with the bot's service account as an Editor, both tabs are
   read through the Sheets API (always current) and a redemption is written to the
   ledger as a negative row. Without that, the bot can still show balances through
   the sheet's public CSV export, but cannot redeem anything. */
import { findRow, normName, normHandle, memberKeys } from "./match.js";
import { eventDate } from "./logic.js";

export const LEDGER_TAB = "Nexus Ledger";
export const SHOP_TAB = "Nexus Shop";

/** A tab as CSV. Google answers a missing tab with the first one, so the caller
    checks the header before trusting it. */
export async function fetchLedger(sheetId, tab = LEDGER_TAB) {
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

/** CSV text → { header, rows as objects keyed by header }. */
function csvTable(csv) {
  const [head, ...body] = parseCsv(csv);
  if (!head) return { header: [], rows: [] };
  const header = head.map((h) => h.trim());
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

/** A cell by its column name, ignoring case and spacing. */
const cell = (obj, name) => {
  const k = Object.keys(obj).find((x) => x.trim().toLowerCase() === name);
  return k === undefined ? "" : String(obj[k] ?? "").trim();
};
const has = (header, name) => header.some((h) => h.trim().toLowerCase() === name);

const entry = (o) => ({
  date: cell(o, "date"), player: cell(o, "player"), points: Number(cell(o, "points")) || 0,
  reason: cell(o, "reason"), source: cell(o, "source"), discordId: cell(o, "discord id")
});

/** Ledger rows from CSV, or null when the CSV is not the ledger. */
export function ledgerRows(csv) {
  const { header, rows } = csvTable(csv);
  if (!header.length) return [];
  if (!has(header, "player") || !has(header, "points") || has(header, "rating")) return null;
  return rows.map(entry);
}

/** A player's balance by name, and their latest entries. Never below zero. */
export function balanceFor(rows, name) {
  const key = normName(name);
  return summarize(rows.filter((r) => normName(r.player) === key));
}

function summarize(mine) {
  const total = Math.round(mine.reduce((a, r) => a + r.points, 0) * 10) / 10;
  return { balance: Math.max(0, total), entries: mine.slice(-5).reverse() };
}

/** The ledger, read through the API when the bot has access, else the public CSV.
    { header, rows, writable }, or null when there is no ledger yet. */
export async function loadLedger(mmr, sheetId, getCsv = fetchLedger) {
  if (mmr) {
    try {
      const { header, rows } = await mmr.readTab(LEDGER_TAB);
      if (!has(header, "player") || !has(header, "points")) return null;
      return { header, rows: rows.map(entry), writable: true };
    } catch (err) {
      if (/Unable to parse range/i.test(String(err.message))) return null;
      if (String(err.message) !== "SHEET_FORBIDDEN") throw err;
    }
  }
  const rows = ledgerRows(await getCsv(sheetId, LEDGER_TAB));
  return rows === null ? null : { header: [], rows, writable: false };
}

/** Does a ledger row's Discord ID cell point at this member? It may hold their
    account ID or their Discord username. */
export function isTheirs(value, who) {
  const h = normHandle(value);
  if (h.kind === "empty") return false;
  if (h.kind === "id") return h.value === who.id;
  return memberKeys(who).has(h.value);
}

/** Which ledger rows are this member's. Rows with their Discord ID count outright.
    Rows under the name from their signup (found by account ID or Discord username,
    as check-in does, never by a typed name) count too, unless that row's Discord ID
    points at somebody else. */
export async function findPlayer(sheet, cfg, who, ledgerRowsList) {
  const byId = ledgerRowsList.filter((r) => isTheirs(r.discordId, who));
  let name = "";
  const { rows: signups } = await sheet.readSignups();
  const hit = findRow(signups, who, { name: cfg.colName, discord: cfg.colDiscord, verifiedId: cfg.colVerifiedId });
  if (hit.status === "matched") name = String(hit.row[cfg.colName] || "").trim();
  const key = normName(name);
  const mine = ledgerRowsList.filter((r) => byId.includes(r) || (key && !r.discordId && normName(r.player) === key));
  return {
    found: Boolean(name) || byId.length > 0,
    name: name || byId[byId.length - 1]?.player || who.globalName || who.username,
    ...summarize(mine)
  };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const pts = (n) => `${n} Nexus Point${n === 1 ? "" : "s"}`;
const notFound = (who) => `I could not find a signup under your Discord username **${who.username}**, ` +
  "and no Nexus Ledger row has your Discord ID, so I do not know which points are yours. " +
  "Sign up for an event with that username first.";

/** /nexus: the caller's balance and latest entries. */
export async function myNexus(sheet, cfg, who, getCsv = fetchLedger, mmr = null) {
  if (!cfg.mmrSheetId) return "Nexus Points are not set up on this bot yet (MMR_SHEET_ID is missing).";
  const ledger = await loadLedger(mmr, cfg.mmrSheetId, getCsv);
  if (!ledger) {
    const { rows } = await sheet.readSignups();
    const hit = findRow(rows, who, { name: cfg.colName, discord: cfg.colDiscord, verifiedId: cfg.colVerifiedId });
    if (hit.status !== "matched") return notFound(who);
    return "No Nexus Points have been handed out yet. They start with the next event.";
  }
  const me = await findPlayer(sheet, cfg, who, ledger.rows);
  if (!me.found) return notFound(who);
  const lines = me.entries.map((e) => `${signed(e.points)} · ${e.reason || "Nexus Points"}${e.date ? ` (${e.date})` : ""}`);
  return `**${me.name}: ${pts(me.balance)}**` +
    (lines.length ? `\nLatest:\n${lines.join("\n")}` : "\nNone yet. You earn them by playing at events.") +
    (cfg.rankingsUrl ? `\nFull standings: ${cfg.rankingsUrl}` : "");
}

/* ---------- The shop ---------- */

const SHOP_HEADER = ["Item", "Cost", "Description"];
const EXAMPLE = ["Pack", "3", "One Riftbound booster pack. Collect it from an officer at the next event."];

const toItems = (rows) => rows.map((o) => ({
  name: cell(o, "item"), cost: Number(cell(o, "cost")), description: cell(o, "description")
})).filter((i) => i.name && i.cost > 0);

/** What the shop sells, from its tab. The tab is made, with one example item, the
    first time anybody opens the shop, so there is something to edit. */
export async function loadShop(mmr, sheetId, getCsv = fetchLedger) {
  if (mmr) {
    try {
      return toItems((await mmr.readTab(SHOP_TAB)).rows);
    } catch (err) {
      if (/Unable to parse range/i.test(String(err.message))) {
        try {
          await mmr.ensureTab(SHOP_TAB);
          await mmr.putValues(`'${SHOP_TAB}'!A1`, [SHOP_HEADER, EXAMPLE]);
        } catch (e) {
          if (String(e.message) === "SHEET_FORBIDDEN") return [];   // view-only access
          throw e;
        }
        return toItems([Object.fromEntries(SHOP_HEADER.map((h, i) => [h, EXAMPLE[i]]))]);
      }
      if (String(err.message) !== "SHEET_FORBIDDEN") throw err;
    }
  }
  const { header, rows } = csvTable(await getCsv(sheetId, SHOP_TAB));
  return has(header, "item") && has(header, "cost") ? toItems(rows) : [];
}

const MAX_ITEMS = 20;   // four rows of five buttons

/** What somebody short on points is told, picked at random, then the actual numbers. */
export const BROKE = [
  "Your wallet just made a sad little noise. 💸",
  "🚨 Broke alert. 🚨",
  "The shopkeeper looked at your points and laughed.",
  "Nice try, but you are running on fumes.",
  "Insufficient funds. Have you tried winning more?",
  "Even the pack is judging you right now.",
  "Your Nexus Points called. They want more friends.",
  "Not enough points. The grind continues. ⚔️",
  "Ain't no way. Go play some more games first.",
  "Your balance is giving free trial.",
  "You reach for your coin pouch. It is just lint.",
  "Bold of you to walk in here with that balance."
];
const broke = (item, balance, rand = Math.random) =>
  `${BROKE[Math.floor(rand() * BROKE.length) % BROKE.length]}\n\n` +
  `**${item.name}** costs ${pts(item.cost)} and you have ${pts(balance)}. You need ${pts(item.cost - balance)} more.`;
const idFor = (prefix, name) => `${prefix}${name}`.slice(0, 100);
const itemFrom = (items, id, prefix) => items.find((i) => idFor(prefix, i.name) === id);
const shopEmbed = (description) => ({ title: "🛒 Nexus Shop", description, color: 0x1c5f7c });
const CANT_WRITE = "Redeeming is not switched on yet: an officer needs to share the Triton MMR sheet with the bot's service account address as an Editor.";

/** Everything the shop needs for one member: the items, the ledger and who they are. */
async function shopState(sheet, mmr, cfg, who, getCsv) {
  if (!cfg.mmrSheetId) return { error: "The Nexus Shop is not set up on this bot yet (MMR_SHEET_ID is missing)." };
  const [items, ledger] = await Promise.all([loadShop(mmr, cfg.mmrSheetId, getCsv), loadLedger(mmr, cfg.mmrSheetId, getCsv)]);
  const me = await findPlayer(sheet, cfg, who, ledger?.rows || []);
  if (!me.found) return { error: notFound(who) };
  return { items, ledger, me };
}

/** The Nexus Shop button: their balance, the items, a button per item. */
export async function shopView(sheet, mmr, cfg, who, getCsv = fetchLedger) {
  const s = await shopState(sheet, mmr, cfg, who, getCsv);
  if (s.error) return s.error;
  const { items, me } = s;
  const head = `**${me.name}**, you have **${pts(me.balance)}**.`;
  if (!items.length) return { content: "", embeds: [shopEmbed(`${head}\n\nThe shop is empty right now. Check back soon.`)], components: [] };

  const shown = items.slice(0, MAX_ITEMS);
  const list = shown.map((i) => `**${i.name}** · ${pts(i.cost)}${i.description ? `\n${i.description}` : ""}`).join("\n\n");
  // Every item gets a button, affordable or not (grey when not): pressing one you
  // cannot afford gets a joke instead of a confirm.
  const buttons = shown.map((i) => ({
    type: 2, style: me.balance >= i.cost ? 1 : 2,
    label: `Redeem ${i.name} (${i.cost})`.slice(0, 80), custom_id: idFor("rb:buy:", i.name)
  }));
  const rows = [];
  for (let k = 0; k < buttons.length; k += 5) rows.push({ type: 1, components: buttons.slice(k, k + 5) });
  return {
    content: "",
    embeds: [shopEmbed(`${head}\n\n${list}\n\nPress an item to redeem it. You will be asked to confirm.`)],
    components: rows
  };
}

/** An item button: ask before spending anything. */
export async function shopConfirm(sheet, mmr, cfg, who, customId, getCsv = fetchLedger, rand = Math.random) {
  const s = await shopState(sheet, mmr, cfg, who, getCsv);
  if (s.error) return s.error;
  const item = itemFrom(s.items, customId, "rb:buy:");
  if (!item) return "That item is not in the shop any more. Press **Nexus Shop** again to see what is.";
  if (s.me.balance < item.cost) return broke(item, s.me.balance, rand);
  return {
    content: "",
    embeds: [shopEmbed(`Spend **${pts(item.cost)}** of your **${s.me.balance}** on **${item.name}**?` +
      `\n\nYou will have ${pts(s.me.balance - item.cost)} left.`)],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: "Confirm", custom_id: idFor("rb:ok:", item.name) },
      { type: 2, style: 2, label: "Cancel", custom_id: "rb:no" }
    ] }]
  };
}

/** Confirm: write the redemption to the ledger. `nonce` is the confirm message's ID,
    kept in the Source column, so a double press cannot redeem twice. */
export async function shopRedeem(sheet, mmr, cfg, who, customId, nonce, getCsv = fetchLedger, rand = Math.random) {
  const s = await shopState(sheet, mmr, cfg, who, getCsv);
  if (s.error) return s.error;
  const item = itemFrom(s.items, customId, "rb:ok:");
  if (!item) return "That item is not in the shop any more. Nothing was spent.";
  const tag = `Nexus Shop #${nonce}`;
  if (s.ledger?.rows.some((r) => r.source === tag)) return `Already redeemed: **${item.name}**. Nothing more was spent.`;
  if (s.me.balance < item.cost) return `${broke(item, s.me.balance, rand)} Nothing was spent.`;
  if (!s.ledger?.writable) return CANT_WRITE;

  const values = { date: eventDate(cfg.tz), player: s.me.name, points: String(-item.cost),
    reason: `Redeemed: ${item.name}`, source: tag, "discord id": who.id };
  const row = s.ledger.header.map((h) => values[h.trim().toLowerCase()] ?? "");
  try {
    await mmr.appendRow(LEDGER_TAB, row);
  } catch (err) {
    if (String(err.message) === "SHEET_FORBIDDEN") return CANT_WRITE;
    throw err;
  }
  return {
    content: "",
    embeds: [shopEmbed(`✅ Redeemed **${item.name}** for ${pts(item.cost)}.\n` +
      `You have **${pts(s.me.balance - item.cost)}** left.\n\n` +
      "Show this message to an officer at the next event to collect it.")],
    components: []
  };
}
