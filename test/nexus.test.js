import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, ledgerRows, balanceFor, myNexus } from "../src/nexus.js";

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
