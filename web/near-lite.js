// near-lite: the few pieces of NEAR this game needs, with no dependencies.
// Runs unchanged in the browser and in Node 20+ (both have WebCrypto Ed25519
// and fetch). The game client, the merchant server and the test bot share it.

// ---------- base58 / base64 ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("Bad base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- amounts ----------
export const YOCTO_PER_NEAR = 10n ** 24n;
/// The game counts in coins: 1 coin = 0.001 NEAR.
export const YOCTO_PER_COIN = 10n ** 21n;
export const coinsToYocto = (coins) => (BigInt(Math.round(coins * 1000)) * YOCTO_PER_COIN) / 1000n;
export const yoctoToCoins = (yocto) => Number(BigInt(yocto) / 10n ** 18n) / 1000;
export const TGAS = 10n ** 12n;

// ---------- keys ----------
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/// Load a NEAR secret key ("ed25519:<base58>", 32-byte seed or 64-byte seed+public).
export async function loadKey(secret) {
  const raw = b58decode(secret.replace(/^ed25519:/, ""));
  if (raw.length !== 32 && raw.length !== 64) throw new Error("Bad secret key length");
  const seed = raw.slice(0, 32);
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, 16);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  // Derive the public key by exporting as JWK (the "x" field is the public point).
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const pub = b64decode(jwk.x.replace(/-/g, "+").replace(/_/g, "/"));
  return {
    publicKey: "ed25519:" + b58encode(pub),
    publicBytes: pub,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, bytes)),
  };
}

/// Make a new key pair. Returns the secret in NEAR's usual text form.
export async function generateKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const both = new Uint8Array(64);
  both.set(seed);
  both.set(pub, 32);
  return { secret: "ed25519:" + b58encode(both), publicKey: "ed25519:" + b58encode(pub) };
}

// ---------- borsh (just what a transaction needs) ----------
class Writer {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    this.parts.push(Uint8Array.of(v));
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
  }
  u64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.parts.push(b);
  }
  u128(v) {
    v = BigInt(v);
    this.u64(v & 0xffffffffffffffffn);
    this.u64(v >> 64n);
  }
  raw(bytes) {
    this.parts.push(bytes);
  }
  bytes(bytes) {
    this.u32(bytes.length);
    this.raw(bytes);
  }
  str(s) {
    this.bytes(new TextEncoder().encode(s));
  }
  publicKey(pk) {
    this.u8(0); // ed25519
    this.raw(typeof pk === "string" ? b58decode(pk.replace(/^ed25519:/, "")) : pk);
  }
  done() {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

// ---------- actions ----------
export const actions = {
  createAccount: () => (w) => w.u8(0),
  functionCall: (method, args = {}, gas = 30n * TGAS, deposit = 0n) => (w) => {
    w.u8(2);
    w.str(method);
    w.bytes(new TextEncoder().encode(JSON.stringify(args)));
    w.u64(gas);
    w.u128(deposit);
  },
  transfer: (yocto) => (w) => {
    w.u8(3);
    w.u128(yocto);
  },
  addFullAccessKey: (publicKey) => (w) => {
    w.u8(5);
    w.publicKey(publicKey);
    w.u64(0); // access key nonce
    w.u8(1); // FullAccess
  },
  addFunctionCallKey: (publicKey, receiverId, methods, allowanceYocto = null) => (w) => {
    w.u8(5);
    w.publicKey(publicKey);
    w.u64(0);
    w.u8(0); // FunctionCall
    if (allowanceYocto === null) w.u8(0);
    else {
      w.u8(1);
      w.u128(allowanceYocto);
    }
    w.str(receiverId);
    w.u32(methods.length);
    for (const m of methods) w.str(m);
  },
};

export class ChainError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ChainError";
    this.detail = detail;
  }
}

/// Pull a human-readable reason out of a failed transaction.
function failureMessage(failure) {
  const text = JSON.stringify(failure);
  const panic = text.match(/Smart contract panicked: ([^"\\]+)/);
  if (panic) return panic[1];
  if (text.includes("NotEnoughBalance") || text.includes("LackBalanceForState")) return "Not enough NEAR for that";
  const kind = text.match(/"kind":\{"(\w+)"/);
  return kind ? kind[1] : "Transaction failed";
}

// ---------- RPC client ----------
export class Near {
  /// `timeoutMs`: how long to wait for a server before trying the next one
  /// (a transaction gets twice as long, and is then looked up, never re-sent).
  constructor(rpcUrls, { timeoutMs = 10_000 } = {}) {
    this.urls = rpcUrls; // the first one is preferred; the rest are fallbacks
    this.timeoutMs = timeoutMs;
    this.idx = 0;
    this.failedOverAt = 0;
    this.queues = new Map(); // one transaction at a time per signer (nonces)
    this.keys = new Map(); // signer -> { nonce, blockHash, at }: saves a lookup per transaction
  }

  async rpc(method, params) {
    let lastErr;
    // after a while on a fallback, go back to the preferred server
    if (this.idx !== 0 && Date.now() - this.failedOverAt > 20_000) this.idx = 0;
    // Free public servers rate-limit bursts (HTTP 429): move to the next one and
    // wait a little longer each time before giving up.
    for (let i = 0; i < this.urls.length * 3; i++) {
      const idx = (this.idx + i) % this.urls.length;
      try {
        const res = await fetch(this.urls[idx], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "tw", method, params }),
          // a server that takes the request and never answers must not hang the game
          signal: AbortSignal.timeout(method === "send_tx" ? this.timeoutMs * 2 : this.timeoutMs),
        });
        if (!res.ok) throw new Error("RPC HTTP " + res.status);
        const j = await res.json();
        if (j.error) {
          const e = new ChainError(typeof j.error.data === "string" ? j.error.data : j.error.cause?.name || j.error.message || "RPC error", j.error);
          e.rpcName = j.error.cause?.name || j.error.name;
          e.fatal = true; // the node answered: do not retry elsewhere
          throw e;
        }
        if (idx !== this.idx) {
          this.idx = idx;
          this.failedOverAt = Date.now();
        }
        return j.result;
      } catch (e) {
        if (e.fatal) throw e;
        if (method === "send_tx" && e.name === "TimeoutError") {
          // No answer is not a "no": the transaction may still land. The caller
          // looks it up by hash instead of sending it twice.
          const t = new ChainError("TIMEOUT: the network did not answer in time", null);
          t.rpcName = "TIMEOUT";
          throw t;
        }
        lastErr = e;
        await new Promise((r) => setTimeout(r, Math.min(3000, 300 * (i + 1))));
      }
    }
    throw lastErr;
  }

  /// Call a read-only contract method.
  async view(contractId, method, args = {}) {
    const res = await this.rpc("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: b64encode(new TextEncoder().encode(JSON.stringify(args))),
    });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
  }

  /// Account balance in yoctoNEAR (0n if the account does not exist).
  async balance(accountId) {
    try {
      const res = await this.rpc("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
      return BigInt(res.amount);
    } catch (e) {
      if (e.rpcName === "UNKNOWN_ACCOUNT") return 0n;
      throw e;
    }
  }

  async accountExists(accountId) {
    try {
      await this.rpc("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
      return true;
    } catch (e) {
      if (e.rpcName === "UNKNOWN_ACCOUNT") return false;
      throw e;
    }
  }

  /// Sign and send a transaction; resolves with the contract's JSON return
  /// value (or null) and the transaction hash. Throws ChainError on failure.
  send(signerId, key, receiverId, actionList) {
    const prev = this.queues.get(signerId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._send(signerId, key, receiverId, actionList));
    this.queues.set(signerId, run);
    return run;
  }

  async _send(signerId, key, receiverId, actionList, attempt = 0) {
    // The key's nonce and a recent block hash, looked up once and then counted
    // locally (this signer sends one transaction at a time).
    const cacheId = signerId + " " + key.publicKey;
    let ak = this.keys.get(cacheId);
    if (!ak || Date.now() - ak.at > 120_000) {
      const res = await this.rpc("query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: signerId,
        public_key: key.publicKey,
      });
      ak = { nonce: BigInt(res.nonce), blockHash: res.block_hash, at: Date.now() };
      this.keys.set(cacheId, ak);
    }
    ak.nonce += 1n;
    const w = new Writer();
    w.str(signerId);
    w.publicKey(key.publicBytes);
    w.u64(ak.nonce);
    w.str(receiverId);
    w.raw(b58decode(ak.blockHash));
    w.u32(actionList.length);
    for (const a of actionList) a(w);
    const txBytes = w.done();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", txBytes));
    const sig = await key.sign(hash);
    const signed = new Uint8Array(txBytes.length + 65);
    signed.set(txBytes);
    signed[txBytes.length] = 0; // ed25519
    signed.set(sig, txBytes.length + 1);
    const txHash = b58encode(hash);

    let res;
    try {
      res = await this.rpc("send_tx", { signed_tx_base64: b64encode(signed), wait_until: "EXECUTED_OPTIMISTIC" });
    } catch (e) {
      const text = JSON.stringify(e.detail ?? e.message ?? "");
      this.keys.delete(cacheId); // look the nonce up again next time
      if (/InvalidNonce|Expired|InvalidTransaction/.test(text) && attempt < 2) return this._send(signerId, key, receiverId, actionList, attempt + 1);
      if (/TIMEOUT|Timeout/.test(text + (e.rpcName ?? ""))) res = await this._waitFor(txHash, signerId);
      else if (/NotEnoughBalance|LackBalance/.test(text)) throw new ChainError("Not enough NEAR for that", e.detail);
      else throw e;
    }
    const status = res.status ?? res.final_execution_status;
    if (status && status.Failure) throw new ChainError(failureMessage(status.Failure), { failure: status.Failure, txHash });
    // A failure in a later receipt (e.g. a refund) does not undo the call; ignore.
    let value = null;
    if (status && typeof status.SuccessValue === "string" && status.SuccessValue.length) {
      try {
        value = JSON.parse(new TextDecoder().decode(b64decode(status.SuccessValue)));
      } catch {
        value = null;
      }
    }
    return { value, txHash };
  }

  async _waitFor(txHash, signerId) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await this.rpc("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" });
        if (res.status && (res.status.Failure || "SuccessValue" in res.status)) return res;
      } catch (e) {
        /* not known yet: keep waiting */
      }
    }
    throw new ChainError("The network took too long to answer", { txHash });
  }
}
