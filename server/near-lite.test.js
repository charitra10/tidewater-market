// The RPC client (web/near-lite.js) against fake RPC servers on localhost:
// a server that never answers must not hang the game, and a transaction that
// gets no answer must be looked up, never sent twice. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Near, generateKey, loadKey, actions, TGAS, b58encode, b64encode } from "../web/near-lite.js";

/// A fake RPC server. `answer(body)` returns the JSON-RPC result, or null to never answer.
async function fakeRpc(answer) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const j = JSON.parse(body);
      calls.push(j.method);
      const result = answer(j);
      if (result === null) return; // say nothing, keep the connection open
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.closeAllConnections() || server.close() };
}

const bytes = (obj) => [...new TextEncoder().encode(JSON.stringify(obj))];
const chain = (j) => {
  if (j.method === "query" && j.params.request_type === "call_function") return { result: bytes("hello") };
  if (j.method === "query" && j.params.request_type === "view_access_key") return { nonce: 7, block_hash: b58encode(new Uint8Array(32).fill(1)) };
  if (j.method === "tx") return { status: { SuccessValue: b64encode(new TextEncoder().encode(JSON.stringify("landed"))) } };
  return null; // send_tx: no answer
};

test("a server that never answers is skipped, not waited on forever", async () => {
  const silent = await fakeRpc(() => null);
  const good = await fakeRpc(chain);
  try {
    const near = new Near([silent.url, good.url], { timeoutMs: 200 });
    const t0 = Date.now();
    assert.equal(await near.view("market.test", "get_market"), "hello");
    assert.ok(Date.now() - t0 < 3000, `answered in ${Date.now() - t0} ms`);
  } finally {
    silent.close();
    good.close();
  }
});

test("a transaction that gets no answer is looked up by hash, never sent twice", async () => {
  const a = await fakeRpc(chain);
  const b = await fakeRpc(chain);
  try {
    const near = new Near([a.url, b.url], { timeoutMs: 200 });
    const key = await loadKey((await generateKey()).secret);
    const r = await near.send("me.test", key, "market.test", [actions.functionCall("forage", { spot: "shore" }, 30n * TGAS, 0n)]);
    assert.equal(r.value, "landed");
    const sends = [...a.calls, ...b.calls].filter((m) => m === "send_tx").length;
    assert.equal(sends, 1, "the signed transaction went out exactly once");
  } finally {
    a.close();
    b.close();
  }
});
