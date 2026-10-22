import test from "node:test";
import assert from "node:assert/strict";
import { cleanEnv } from "../src/index.js";

test("secrets lose a leading byte order mark and stray whitespace", () => {
  const key = "ab".repeat(32);
  const env = cleanEnv({
    DISCORD_PUBLIC_KEY: "\uFEFF" + key,
    DISCORD_APP_ID: " 123456789012345678\r\n",
    GOOGLE_CREDENTIALS: "\uFEFF{\"client_email\":\"x\"}\n",
    COL_NAME: "What is your name"
  });
  assert.equal(env.DISCORD_PUBLIC_KEY, key);
  assert.equal(env.DISCORD_PUBLIC_KEY.length, 64);
  assert.equal(env.DISCORD_APP_ID, "123456789012345678");
  assert.deepEqual(JSON.parse(env.GOOGLE_CREDENTIALS), { client_email: "x" });
  assert.equal(env.COL_NAME, "What is your name");
});

test("non-string bindings pass through untouched", () => {
  const kv = { get() {} };
  assert.equal(cleanEnv({ KV: kv }).KV, kv);
});
