// Maren's wanted orders, her auctions and both merchants' answers to offers.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { shortfall, orderPlan, orderDeadline, staleOrders, auctionPlan, offerAnswer, leastFor, unitBid, ORDER_PREMIUM, AUCTION_REST_MS, TERMS } from "../web/merchant.js";
import { tideAt, TIDE_PERIOD_MS } from "../web/tide.js";

const NOW = 1_794_610_000_000;
const tokens = ["kelp", "driftwood", "ore", "pearl", "rope", "pickaxe", "boat", "beacon"];
const by = (a) => Object.fromEntries(tokens.map((t, i) => [t, a[i]]));
function market(stock, extra = {}) {
  return {
    stock: by(stock),
    avgCost: by([2, 4, 20, 60, 12, 40, 200, 500]),
    treasury: 2000,
    floor: by([2, 3, 15, 40, 12, 35, 150, 400]),
    ceiling: by([8, 12, 60, 160, 40, 120, 600, 1800]),
    exportPrice: by([3, 4, 20, 55, 0, 0, 0, 0]),
    tide: tideAt(NOW),
    storm: { active: false },
    event: { kind: null, active: false },
    recent: {},
    ...extra,
  };
}

test("she orders what she lacks to make what she has run out of", () => {
  // no boat; 1 driftwood, rope enough, no ore: she needs 3 driftwood and 2 ore
  const m = market([9, 1, 0, 4, 3, 2, 0, 1]);
  assert.deepEqual(shortfall(m), { out: "boat", short: { driftwood: 3, ore: 2 } });
  const plan = orderPlan(m, [], NOW);
  assert.deepEqual(plan.map((o) => [o.token, o.qty, o.for]), [["driftwood", 3, "boat"], ["ore", 2, "boat"]]);
  for (const o of plan) {
    assert.equal(o.unit, Math.min(Math.ceil(unitBid(m, o.token) * ORDER_PREMIUM), m.ceiling[o.token]));
    assert.ok(o.unit > unitBid(m, o.token), "an order pays more than her usual bid");
    assert.match(o.why, /out of boats/);
  }
  // rope is counted as the kelp it takes: no rope, 2 kelp, boat needs 2 rope = 6 kelp
  assert.deepEqual(shortfall(market([2, 9, 9, 4, 0, 2, 0, 1])), { out: "boat", short: { kelp: 4 } });
});

test("she doesn't order twice, past three orders, or what she can't pay for", () => {
  const m = market([0, 0, 0, 0, 0, 2, 0, 1]);
  assert.deepEqual(orderPlan(m, [{ token: "driftwood" }], NOW).map((o) => o.token), ["ore", "kelp"]);
  assert.equal(orderPlan(m, [{ token: "x" }, { token: "y" }, { token: "z" }], NOW).length, 0);
  assert.equal(orderPlan({ ...m, treasury: 10 }, [], NOW).length, 0);
  assert.equal(orderPlan({ ...m, shop: { closed: true } }, [], NOW).length, 0);
  // nothing missing: no orders
  assert.equal(orderPlan(market([9, 8, 4, 4, 3, 2, 1, 1]), [], NOW).length, 0);
});

test("a red tide's kelp is not wanted, even on order", () => {
  const m = market([0, 9, 9, 4, 0, 2, 0, 1], { event: { kind: "red_tide", active: true } });
  assert.equal(orderPlan(m, [], NOW).length, 0);
});

test("an order runs until the next high tide at least three minutes away", () => {
  for (let i = 0; i < 40; i++) {
    const now = NOW + i * 37_000;
    const end = orderDeadline(now);
    assert.equal(tideAt(end).phase, "high");
    assert.ok(end >= now + 3 * 60_000 && end <= now + 3 * 60_000 + TIDE_PERIOD_MS, `${end - now}`);
    assert.ok(end - now <= TERMS.orderMaxMs);
  }
});

test("orders come down once she has what she wanted", () => {
  const before = market([9, 1, 0, 4, 3, 2, 0, 1]);
  const orders = orderPlan(before, [], NOW);
  assert.deepEqual(staleOrders(before, orders), []);
  const after = market([9, 4, 2, 4, 3, 2, 0, 1]);
  assert.deepEqual(staleOrders(after, orders).map((o) => o.token), ["driftwood", "ore"]);
});

test("she auctions her last lens only, not straight after the last auction", () => {
  const one = market([9, 8, 4, 4, 3, 2, 1, 1]);
  const plan = auctionPlan(one, null, NOW);
  assert.equal(plan.token, "beacon");
  assert.equal(plan.reserve, Math.max(400, Math.ceil(500 * 1.15)));
  assert.ok(plan.endsMs - NOW >= TERMS.auctionMinMs && plan.endsMs - NOW <= TERMS.auctionMaxMs);
  assert.equal(auctionPlan(market([9, 8, 4, 4, 3, 2, 1, 2]), null, NOW), null, "two lenses: she just sells them");
  assert.equal(auctionPlan(market([9, 8, 4, 4, 3, 2, 1, 0]), null, NOW), null);
  assert.equal(auctionPlan(one, { settled: false, endsMs: NOW + 1 }, NOW), null, "one at a time");
  assert.equal(auctionPlan(one, { settled: true, endsMs: NOW - AUCTION_REST_MS + 1000 }, NOW), null, "a rest between auctions");
  assert.ok(auctionPlan(one, { settled: true, endsMs: NOW - AUCTION_REST_MS }, NOW));
  assert.equal(auctionPlan(one, null, NOW, { active: false }), null, "nobody around to bid");
});

test("merchants take enough, counter what is close, and turn the rest down", () => {
  assert.deepEqual(offerAnswer({ offer: 30, ask: 35, least: 28 }), { answer: "accept" });
  assert.deepEqual(offerAnswer({ offer: 25, ask: 35, least: 28 }), { answer: "counter", counter: 28 });
  assert.deepEqual(offerAnswer({ offer: 10, ask: 35, least: 28 }), { answer: "decline" });
  // a counter never goes under their least: when the notice already asks no more, they say no
  assert.deepEqual(offerAnswer({ offer: 25, ask: 28, least: 28 }), { answer: "decline" });
  for (let i = 0; i < 2000; i++) {
    const least = 1 + Math.floor(Math.random() * 100);
    const ask = least + Math.floor(Math.random() * 40) - 5;
    const offer = Math.floor(Math.random() * ask);
    const a = offerAnswer({ offer, ask, least });
    if (a.answer === "accept") assert.ok(offer >= least);
    if (a.answer === "counter") assert.ok(a.counter >= least && a.counter > offer && a.counter < ask);
  }
});

test("the least each merchant takes covers their floor, their cost and the other buyer", () => {
  const m = market([9, 8, 9, 4, 3, 2, 1, 1], { dealer: { avgCost: { ore: 33, pearl: 0 }, cityPrice: { ore: 30, pearl: 82 } } });
  assert.equal(leastFor("maren", m, "ore"), Math.ceil(Math.max(15, 20, 21)));
  assert.equal(leastFor("silas", m, "ore"), 33);
  assert.equal(leastFor("silas", m, "pearl"), 83);
});
