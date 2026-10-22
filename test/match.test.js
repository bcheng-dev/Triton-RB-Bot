import test from "node:test";
import assert from "node:assert/strict";
import { findRow, normHandle, normName, isTruthy, memberKeys } from "../src/match.js";

const cols = { name: "Name", discord: "Discord", verifiedId: "Discord ID (verified)" };
const R = (name, discord, verified = "") => ({ Name: name, Discord: discord, "Discord ID (verified)": verified, _line: 2 });

test("handles the shapes people actually type", () => {
  assert.equal(normHandle("@lucas").value, "lucas");
  assert.equal(normHandle("Lucas#1234").value, "lucas");
  assert.equal(normHandle("lucas#0").value, "lucas");
  assert.equal(normHandle("  LuCaS  ").value, "lucas");
  assert.equal(normHandle("123456789012345678").kind, "id");
  assert.equal(normHandle("https://discord.com/users/123456789012345678").value, "123456789012345678");
  assert.equal(normHandle("").kind, "empty");
  assert.equal(normHandle("my discord").value, "mydiscord");
});

test("names normalise past accents, case and punctuation", () => {
  assert.equal(normName("Jun-Ting Chiang"), "jun ting chiang");
  assert.equal(normName("josé  GARCÍA"), "jose garcia");
});

test("a verified ID wins over everything", () => {
  const rows = [R("Someone Else", "lucas"), R("Lucas", "wrongname", "111111111111111111")];
  const hit = findRow(rows, { id: "111111111111111111", username: "lucas" }, cols);
  assert.equal(hit.status, "matched");
  assert.equal(hit.by, "id");
  assert.equal(hit.row.Name, "Lucas");
});

test("an ID typed straight into the form box matches", () => {
  const rows = [R("Ari", "222222222222222222")];
  const hit = findRow(rows, { id: "222222222222222222", username: "arimain" }, cols);
  assert.equal(hit.status, "matched");
  assert.equal(hit.by, "id");
});

test("handle match works on username, global name and server nickname", () => {
  for (const who of [
    { id: "9", username: "robbie" },
    { id: "9", username: "other", globalName: "Robbie" },
    { id: "9", username: "other", nickname: "robbie" }
  ]) {
    const hit = findRow([R("Robbie", "@Robbie")], who, cols);
    assert.equal(hit.status, "matched", JSON.stringify(who));
    assert.equal(hit.by, "handle");
  }
});

test("two rows claiming the same handle is refused, not guessed", () => {
  const rows = [R("A", "lucas"), R("B", "@lucas")];
  const hit = findRow(rows, { id: "9", username: "lucas" }, cols);
  assert.equal(hit.status, "ambiguous");
});

test("a real-name lookalike is never auto-checked in", () => {
  // Their Discord box points somewhere else; only the display name agrees.
  const rows = [R("Alice Chen", "someoneelse")];
  const hit = findRow(rows, { id: "9", username: "ac2027", globalName: "Alice Chen" }, cols);
  assert.equal(hit.status, "none");
  assert.equal(hit.by, "name");
  assert.equal(hit.rows[0].Name, "Alice Chen");   // surfaced to the organizer, not acted on
});

test("nobody signed up under that account", () => {
  const hit = findRow([R("Ari", "ari")], { id: "9", username: "stranger" }, cols);
  assert.equal(hit.status, "none");
  assert.deepEqual(hit.rows, []);
});

test("an empty Discord box never matches an empty-ish member field", () => {
  const rows = [R("Ghost", "")];
  const hit = findRow(rows, { id: "9", username: "ghost2", globalName: "" }, cols);
  assert.equal(hit.status, "none");
});

test("member keys do not collapse to the empty string", () => {
  const keys = memberKeys({ id: "9", username: "x", globalName: "", nickname: null });
  assert.ok(!keys.has(""));
});

test("checked cell truthiness", () => {
  assert.equal(isTruthy("2026-10-19"), true);
  assert.equal(isTruthy("TRUE"), true);
  assert.equal(isTruthy(""), false);
  assert.equal(isTruthy("FALSE"), false);
  assert.equal(isTruthy("  "), false);
});
