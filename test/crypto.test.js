import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/discord.js";

const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function signed(bodyText, ts, keys) {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(ts + bodyText)
  );
  return toHex(sig);
}

test("Discord signature verification accepts a good signature and rejects everything else", async () => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const body = JSON.stringify({ type: 1 });
  const ts = "1760000000";
  const good = await signed(body, ts, keys);

  const req = (sig, stamp) => new Request("https://x/", {
    method: "POST",
    headers: { "x-signature-ed25519": sig, "x-signature-timestamp": stamp }
  });

  assert.equal(await verify(req(good, ts), body, pub), true, "valid signature must pass");

  // A tampered body is the attack that matters: same signature, different payload.
  assert.equal(await verify(req(good, ts), JSON.stringify({ type: 2 }), pub), false);
  // Replayed with a different timestamp.
  assert.equal(await verify(req(good, "1760000001"), body, pub), false);
  // Garbage signature.
  assert.equal(await verify(req("00".repeat(64), ts), body, pub), false);
  // Missing headers entirely.
  assert.equal(await verify(new Request("https://x/", { method: "POST" }), body, pub), false);
  // Signed by somebody else's key.
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  assert.equal(await verify(req(await signed(body, ts, other), ts), body, pub), false);
  // Malformed public key must not throw, just fail.
  assert.equal(await verify(req(good, ts), body, "nothex"), false);
});

test("service account JWT signs with RS256 and verifies", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g).join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;

  // Exactly what google.js does to a service account key file.
  const der = (() => {
    const b = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const raw = atob(b);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  })();

  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const msg = new TextEncoder().encode("header.claims");
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, msg);
  assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, sig, msg), true);
});

test("base64url encoding has no padding or unsafe characters", async () => {
  const b64url = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  for (let n = 1; n < 40; n++) {
    const out = b64url(crypto.getRandomValues(new Uint8Array(n)));
    assert.ok(!/[+/=]/.test(out), `n=${n} produced ${out}`);
  }
});
