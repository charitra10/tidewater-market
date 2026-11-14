// Sign in with Google (server/login.js), with tokens signed by a test key of our
// own standing in for Google's. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyIdToken, accountFor, googleKeys, decodeJwt } from "./login.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload, { key = privateKey, kid = "k1", alg = "RS256" } = {}) {
  const head = enc({ alg, kid, typ: "JWT" });
  const body = enc(payload);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const NOW = 1_794_600_000_000;
const good = { iss: "https://accounts.google.com", aud: "client-1.apps.googleusercontent.com", sub: "1234567890", iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, email: "someone@example.com" };
const opts = { clientId: good.aud, keyFor: async (kid) => (kid === "k1" ? jwk : undefined), now: NOW };

test("a good token gives Google's id for the person, and nothing else", async () => {
  assert.deepEqual(await verifyIdToken(sign(good), opts), { sub: "1234567890" });
});

test("tokens that must be refused are refused", async () => {
  const bad = async (token, why) => assert.rejects(verifyIdToken(token, opts), why);
  await bad(sign({ ...good, aud: "someone-else" }), /another app/);
  await bad(sign({ ...good, iss: "https://evil.example" }), /not from Google/);
  await bad(sign({ ...good, exp: NOW / 1000 - 1 }), /expired/);
  await bad(sign({ ...good, iat: NOW / 1000 + 3600 }), /future/);
  await bad(sign({ ...good, sub: "" }), /nobody/);
  await bad(sign(good, { key: other.privateKey }), /bad signature/);
  await bad(sign(good, { kid: "k9" }), /unknown signing key/);
  await bad("not.a.token", /./);
  // a token whose body was changed after signing
  const [h, , s] = sign(good).split(".");
  await bad(`${h}.${enc({ ...good, sub: "999" })}.${s}`, /bad signature/);
});

test("the same person gets the same account, and it says nothing about them", () => {
  const a = accountFor("1234567890", "secret-1", "guests.example.testnet");
  assert.equal(a, accountFor("1234567890", "secret-1", "guests.example.testnet"));
  assert.match(a, /^u[0-9a-f]{10}\.guests\.example\.testnet$/);
  assert.notEqual(a, accountFor("1234567891", "secret-1", "guests.example.testnet"));
  assert.notEqual(a, accountFor("1234567890", "secret-2", "guests.example.testnet"), "without the secret nobody can work it out");
  assert.doesNotMatch(a, /1234567890/);
});

test("Google's keys are fetched once and kept as long as Google says", async () => {
  let fetches = 0;
  const keyFor = googleKeys(async () => {
    fetches++;
    return { ok: true, headers: new Map([["cache-control", "public, max-age=600"]]), json: async () => ({ keys: [jwk] }) };
  });
  assert.equal((await keyFor("k1")).kid, "k1");
  await keyFor("k1");
  assert.equal(fetches, 1);
  assert.equal(await keyFor("missing"), undefined);
  assert.equal(fetches, 2, "an unknown key id fetches again (Google rotates its keys)");
  assert.equal(decodeJwt(sign(good)).payload.email, "someone@example.com", "(the email is in the token, but we never use it)");
});
