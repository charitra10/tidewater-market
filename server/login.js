// Sign in with Google, with no database and no email kept.
//
// The browser gets an ID token from Google (a signed JWT) and sends it here with
// a fresh public key. We check Google's signature (its published keys, by `kid`,
// with node:crypto only), the audience (our client ID), the issuer and the
// expiry, and keep only `sub`, Google's stable id for the person. The account
// name is derived from it with a secret, so nobody can link an account to an
// email without the server's LOGIN_SECRET, and the same person always gets the
// same account on any device.
import crypto from "node:crypto";

export const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
export const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const SKEW_MS = 5 * 60_000;

const b64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("not a token");
  return {
    header: JSON.parse(b64url(parts[0]).toString("utf8")),
    payload: JSON.parse(b64url(parts[1]).toString("utf8")),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: b64url(parts[2]),
  };
}

/// Checks a Google ID token and returns { sub }, or throws saying why not.
/// `keyFor(kid)` gives Google's public key (a JWK) for that key id.
export async function verifyIdToken(token, { clientId, keyFor, now = Date.now() }) {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== "RS256") throw new Error("unexpected signature type");
  const jwk = await keyFor(header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(signingInput), key, signature)) throw new Error("bad signature");
  if (payload.aud !== clientId) throw new Error("token is for another app");
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("token is not from Google");
  if (!(payload.exp * 1000 > now)) throw new Error("token has expired");
  if (payload.iat && payload.iat * 1000 > now + SKEW_MS) throw new Error("token is from the future");
  if (!payload.sub) throw new Error("token names nobody");
  return { sub: String(payload.sub) };
}

/// Google's public keys, fetched when needed and kept for as long as Google says.
export function googleKeys(fetchFn = fetch) {
  let cache = { at: 0, maxAgeMs: 0, keys: {} };
  return async (kid) => {
    if (!cache.keys[kid] || Date.now() - cache.at > cache.maxAgeMs) {
      const res = await fetchFn(GOOGLE_CERTS);
      if (!res.ok) throw new Error("couldn't reach Google's keys");
      const age = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
      const { keys } = await res.json();
      cache = { at: Date.now(), maxAgeMs: age * 1000, keys: Object.fromEntries(keys.map((k) => [k.kid, k])) };
    }
    return cache.keys[kid];
  };
}

/// The account a Google id signs in to: `u` and ten hex characters of an HMAC
/// of it, under the guest fund's account.
export function accountFor(sub, secret, parent) {
  const h = crypto.createHmac("sha256", secret).update(`google:${sub}`).digest("hex").slice(0, 10);
  return `u${h}.${parent}`;
}
