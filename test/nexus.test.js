import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, ledgerRows, balanceFor, myNexus, shopView, shopConfirm, shopRedeem, isTheirs, BROKE } from "../src/nexus.js";

const cfg = { colName: "Name", colDiscord: "Discord", colVerifiedId: "Discord ID (verified)",
              mmrSheetId: "sheet", rankingsUrl: "https://example.com/" };
const sheet = (rows) => ({ async readSignups(){ return { header: ["Name", "Discord"], rows }; } });

const LEDGER = [
  '"Date","Player","Points","Reason","Source"',
  '"2026-11-13","Terence Zhang","3","Top 10 (#1)","event"',
  '"2026-11-13","Sam Kuang","1","Attended","event"',
  '"2026-11-20","Terence Zhang","-2","Redeemed: sleeves, ""foil""",""'
].join("\n");

test("CSV with quotes, commas and doubled quotes", () => {
  const rows = parseCsv(LEDGER);
  assert.equal(rows.length, 4);
  assert.equal(rows[3][3], 'Redeemed: sleeves, "foil"');
});

test("a tab that is not the ledger is refused", () => {
  assert.equal(ledgerRows('"Player","Rating","Category"\n"Ann","1000","Noob"'), null);
});

test("balance sums the rows and never goes below zero", () => {
  const rows = ledgerRows(LEDGER);
  assert.equal(balanceFor(rows, "terence zhang").balance, 1);
  assert.equal(balanceFor(rows.concat([{ player: "Sam Kuang", points: -5 }]), "Sam Kuang").balance, 0);
});

test("/nexus finds the member by Discord username and shows their points", async () => {
  const out = await myNexus(sheet([{ Name: "Terence Zhang", Discord: "terryz" }]), cfg,
    { id: "1", username: "terryz" }, async () => LEDGER);
  assert.match(out, /Terence Zhang: 1 Nexus Point\*\*/);
  assert.match(out, /-2 · Redeemed/);
});

test("/nexus never guesses a member by name alone", async () => {
  const out = await myNexus(sheet([{ Name: "Terence Zhang", Discord: "someoneelse" }]), cfg,
    { id: "1", username: "terryz", globalName: "Terence Zhang" }, async () => LEDGER);
  assert.match(out, /could not find a signup/);
});

test("/nexus before any points exist", async () => {
  const out = await myNexus(sheet([{ Name: "Ann", Discord: "ann" }]), cfg, { id: "1", username: "ann" },
    async () => '"Player","Rating"\n"Ann","1000"');
  assert.match(out, /No Nexus Points have been handed out yet/);
});

/* ---------- Discord IDs on the ledger, and the shop ---------- */

const LEDGER_HEAD = ["Date", "Player", "Points", "Reason", "Source", "Discord ID"];
/** The Triton MMR sheet through the API, in memory. */
function fakeMmr({ ledger = [], shop } = {}) {
  const tabs = { "Nexus Ledger": [LEDGER_HEAD, ...ledger] };
  if (shop) tabs["Nexus Shop"] = [["Item", "Cost", "Description"], ...shop];
  return {
    tabs, appended: [],
    async readTab(tab) {
      if (!tabs[tab]) throw new Error(`sheets 400: Unable to parse range: '${tab}'`);
      const [header, ...body] = tabs[tab];
      return { header, rows: body.map((r, i) => ({ _line: i + 2, ...Object.fromEntries(header.map((h, c) => [h, r[c] ?? ""])) })) };
    },
    async ensureTab(tab) { tabs[tab] = tabs[tab] || []; },
    async putValues(range, values) { tabs[/'(.+)'/.exec(range)[1]] = values; },
    async appendRow(tab, row) { this.appended.push(row); tabs[tab].push(row); }
  };
}
const brian = { id: "303203396788289537", username: "penguinstacy" };
const noSignups = sheet([]);

test("a ledger row's Discord ID can be an account ID or a username", () => {
  assert.ok(isTheirs("303203396788289537", brian));
  assert.ok(isTheirs("@PenguinStacy", brian));
  assert.ok(!isTheirs("someoneelse", brian));
  assert.ok(!isTheirs("", brian));
});

test("/nexus finds points by the Discord ID column with no signup at all", async () => {
  const mmr = fakeMmr({ ledger: [["11/12", "test", "5", "", "", "penguinstacy"]] });
  const out = await myNexus(noSignups, cfg, brian, undefined, mmr);
  assert.match(out, /test: 5 Nexus Points/);
});

test("a name match does not take a row whose Discord ID is somebody else's", async () => {
  const mmr = fakeMmr({ ledger: [
    ["11/12", "Ann Lee", "4", "", "", ""],
    ["11/12", "Ann Lee", "9", "", "", "otherann"]
  ] });
  const out = await myNexus(sheet([{ Name: "Ann Lee", Discord: "annl" }]), cfg, { id: "7", username: "annl" }, undefined, mmr);
  assert.match(out, /Ann Lee: 4 Nexus Points/);
});

test("the shop is made with an example item the first time, and shows the balance", async () => {
  const mmr = fakeMmr({ ledger: [["11/12", "test", "5", "", "", "penguinstacy"]] });
  const view = await shopView(noSignups, mmr, cfg, brian);
  assert.deepEqual(mmr.tabs["Nexus Shop"][0], ["Item", "Cost", "Description"]);
  assert.match(view.embeds[0].description, /you have \*\*5 Nexus Points\*\*/);
  const btn = view.components[0].components[0];
  assert.equal(btn.custom_id, "rb:buy:Pack");
  assert.equal(btn.label, "Redeem Pack (3)");
});

test("every item gets a Redeem button; one you cannot afford is grey and gets a joke", async () => {
  const mmr = fakeMmr({ ledger: [["11/12", "test", "5", "", "", "penguinstacy"]], shop: [["Pack", "3", ""], ["Option B", "40", ""]] });
  const [pack, b] = (await shopView(noSignups, mmr, cfg, brian)).components[0].components;
  assert.deepEqual([pack.label, pack.style, b.label, b.style], ["Redeem Pack (3)", 1, "Redeem Option B (40)", 2]);
  assert.ok(!b.disabled);
  const out = await shopConfirm(noSignups, mmr, cfg, brian, "rb:buy:Option B", undefined, () => 0);
  assert.ok(out.startsWith(BROKE[0]));
  assert.match(out, /\*\*Option B\*\* costs 40 Nexus Points and you have 5 Nexus Points\. You need 35 Nexus Points more/);
  assert.ok((await shopConfirm(noSignups, mmr, cfg, brian, "rb:buy:Option B", undefined, () => 0.999)).startsWith(BROKE.at(-1)));
});

test("redeeming asks first, then writes one negative ledger row, and only once", async () => {
  const mmr = fakeMmr({ ledger: [["11/12", "test", "5", "", "", "penguinstacy"]], shop: [["Pack", "5", "A pack"]] });
  const ask = await shopConfirm(noSignups, mmr, cfg, brian, "rb:buy:Pack");
  assert.match(ask.embeds[0].description, /Spend \*\*5 Nexus Points\*\* of your \*\*5\*\* on \*\*Pack\*\*/);
  assert.equal(ask.components[0].components[0].custom_id, "rb:ok:Pack");
  assert.equal(mmr.appended.length, 0, "nothing is spent before Confirm");

  const done = await shopRedeem(noSignups, mmr, { ...cfg, tz: "America/Los_Angeles" }, brian, "rb:ok:Pack", "msg1");
  assert.match(done.embeds[0].description, /Redeemed \*\*Pack\*\* for 5 Nexus Points[\s\S]*0 Nexus Points\*\* left/);
  const row = mmr.appended[0];
  assert.deepEqual(row.slice(1), ["test", "-5", "Redeemed: Pack", "Nexus Shop #msg1", brian.id]);

  assert.match(await shopRedeem(noSignups, mmr, cfg, brian, "rb:ok:Pack", "msg1"), /Already redeemed/);
  assert.match(await shopRedeem(noSignups, mmr, cfg, brian, "rb:ok:Pack", "msg2"), /you have 0 Nexus Points\. You need 5 Nexus Points more\. Nothing was spent/);
  assert.equal(mmr.appended.length, 1);
});

test("without edit access the shop shows points but will not redeem", async () => {
  const csv = (id, tab) => tab === "Nexus Shop"
    ? '"Item","Cost","Description"\n"Pack","5",""'
    : '"Date","Player","Points","Reason","Source","Discord ID"\n"11/12","test","5","","","penguinstacy"';
  const forbidden = { async readTab() { throw new Error("SHEET_FORBIDDEN"); } };
  const view = await shopView(noSignups, forbidden, cfg, brian, csv);
  assert.match(view.embeds[0].description, /5 Nexus Points/);
  assert.match(await shopRedeem(noSignups, forbidden, cfg, brian, "rb:ok:Pack", "m", csv), /share the Triton MMR sheet/);
});

test("somebody the bot cannot place gets no shop", async () => {
  const mmr = fakeMmr({ ledger: [["11/12", "test", "5", "", "", "penguinstacy"]] });
  assert.match(await shopView(noSignups, mmr, cfg, { id: "9", username: "stranger" }), /could not find a signup/);
});
