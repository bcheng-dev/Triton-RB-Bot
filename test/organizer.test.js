import test from "node:test";
import assert from "node:assert/strict";
import { isOrganizer } from "../src/index.js";

// A server's roles, bottom to top. Server Booster is managed by Discord and sits
// above Officer here on purpose: it must not count.
const ROLES = [
  { id: "g", position: 0 },                          // @everyone
  { id: "member", position: 1 },
  { id: "officer", position: 5 },
  { id: "booster", position: 7, managed: true },
  { id: "president", position: 8 },
  { id: "alumni-officer", position: 9 }
];
const loadRoles = async () => ROLES;
const env = { ORGANIZER_ROLE_IDS: "officer", DISCORD_BOT_TOKEN: "t" };
const as = (roles, permissions = "0") => ({ guild_id: "g", member: { roles, permissions } });
const ADMIN = String(1n << 3n);
const MANAGE_EVENTS = String(1n << 33n);

test("officers count", async () => {
  assert.equal(await isOrganizer(as(["member", "officer"]), env, loadRoles), true);
});

test("roles ranked above Officer count without being listed", async () => {
  assert.equal(await isOrganizer(as(["president"]), env, loadRoles), true);
});

test("members below Officer do not", async () => {
  assert.equal(await isOrganizer(as(["member"]), env, loadRoles), false);
  assert.equal(await isOrganizer(as([]), env, loadRoles), false);
});

test("a managed role like Server Booster never counts, even above Officer", async () => {
  assert.equal(await isOrganizer(as(["member", "booster"]), env, loadRoles), false);
});

test("administrators and the owner always pass, without a role lookup", async () => {
  const never = async () => { throw new Error("must not look up roles"); };
  assert.equal(await isOrganizer(as([], ADMIN), env, never), true);
});

test("Manage Events alone is not enough once an officer role is set", async () => {
  assert.equal(await isOrganizer(as(["member"], MANAGE_EVENTS), env, loadRoles), false);
});

test("without an officer role set, Manage Events or Manage Server is enough", async () => {
  assert.equal(await isOrganizer(as([], MANAGE_EVENTS), {}, loadRoles), true);
  assert.equal(await isOrganizer(as([], "0"), {}, loadRoles), false);
});

test("one officer role per server: IDs from other servers are ignored here", async () => {
  const two = { ...env, ORGANIZER_ROLE_IDS: "other-server-officer, officer" };
  assert.equal(await isOrganizer(as(["president"]), two, loadRoles), true);
  const none = { ...env, ORGANIZER_ROLE_IDS: "other-server-officer" };
  assert.equal(await isOrganizer(as(["president"]), none, loadRoles), false);
});

test("if Discord will not list the roles, the answer is no", async (t) => {
  t.mock.method(console, "error", () => {});
  const failing = async () => { throw new Error("503"); };
  assert.equal(await isOrganizer(as(["president"]), env, failing), false);
  assert.equal(await isOrganizer(as(["officer"]), env, failing), true, "holding the role itself needs no lookup");
});

test("alumni officer roles are ignored, even ranked above Officer", async () => {
  const withAlumni = { ...env, ORGANIZER_IGNORE_ROLE_IDS: "alumni-officer" };
  assert.equal(await isOrganizer(as(["member", "alumni-officer"]), withAlumni, loadRoles), false);
  assert.equal(await isOrganizer(as(["president"]), withAlumni, loadRoles), true, "other roles above still count");
});

test("a current officer who is also an alumnus still counts", async () => {
  const withAlumni = { ...env, ORGANIZER_IGNORE_ROLE_IDS: "alumni-officer" };
  assert.equal(await isOrganizer(as(["officer", "alumni-officer"]), withAlumni, loadRoles), true);
});

test("without the ignore list, a role above Officer counts, alumni or not", async () => {
  assert.equal(await isOrganizer(as(["alumni-officer"]), env, loadRoles), true);
});
