// Silas, the pearl and ore dealer (web/merchant.js), and how he competes
// with Maren. No network. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { dealerBid, dealerBoard, openDealerHaggle, shipPlan, haggle, unitBid, boardPicks, marenNotices, silasNotices, dealerPicks, promisedBy, staleNotices, MERCHANT_NOTICE_MS, DEALER_HOLD, DEALER_TOKENS, TARGET } from "../web/merchant.js";
import { writtenLine } from "./voice.js";

const zero = { kelp: 0, driftwood: 0, ore: 0, pearl: 0, rope: 0, pickaxe: 0, boat: 0, beacon: 0 };
/// Silas's books as the server keeps them (coins), with the rules he runs under on testnet.
const silas = (over = {}) => ({
  stock: { ...zero, ...over.stock },
  treasury: over.treasury ?? 500,
  ceiling: { ...zero, ore: 40, pearl: 100 },
  cityPrice: { ...zero, ore: 30, pearl: 82 },
  windowLimit: 600,
  boughtInWindow: over.boughtInWindow ?? 0,
  tide: over.tide,
  storm: over.storm,
});
/// Maren's books, close to the live market's.
const maren = (over = {}) => ({
  stock: { kelp: 8, driftwood: 8, ore: 5, pearl: 3, rope: 3, pickaxe: 2, boat: 1, beacon: 1, ...over.stock },
  avgCost: { ...zero, ore: 20, pearl: 50 },
  treasury: 2476,
  floor: { kelp: 2, driftwood: 3, ore: 15, pearl: 40, rope: 12, pickaxe: 35, boat: 140, beacon: 350 },
  ceiling: { kelp: 6, driftwood: 9, ore: 42, pearl: 110, rope: 24, pickaxe: 60, boat: 240, beacon: 600 },
});

test("he pays most with an empty hold, and swings harder with it than Maren does with her shelves", () => {
  for (const t of DEALER_TOKENS) {
    const empty = dealerBid(silas(), t);
    const full = dealerBid(silas({ stock: { [t]: DEALER_HOLD[t] } }), t);
    assert.ok(empty > full);
    const hers = unitBid(maren({ stock: { [t]: 0 } }), t) / unitBid(maren({ stock: { [t]: TARGET[t] } }), t);
    assert.ok(empty / full > hers, `${t}: his swing ${(empty / full).toFixed(2)} vs hers ${hers.toFixed(2)}`);
  }
});

test("he never offers more than 95% of what the city pays him, nor past his on-chain ceiling", () => {
  for (const t of DEALER_TOKENS) {
    for (let stock = 0; stock < 12; stock++) {
      for (const tide of [undefined, { phase: "high", spring: true }, { phase: "low", spring: true }]) {
        const d = silas({ stock: { [t]: stock }, tide });
        const bid = dealerBid(d, t);
        assert.ok(bid <= d.cityPrice[t] * 0.95 && bid <= d.ceiling[t], `${t} x${stock}`);
      }
    }
  }
  assert.equal(dealerBid(silas(), "kelp"), 0, "he does not buy kelp");
});

test("in a storm he buys nothing; the tide moves him like it moves Maren", () => {
  assert.equal(dealerBid(silas({ storm: { active: true } }), "pearl"), 0);
  assert.ok(dealerBoard(silas({ storm: { active: true } })).every((r) => r.price === 0));
  assert.ok(dealerBid(silas({ tide: { phase: "low", spring: false } }), "pearl") < dealerBid(silas(), "pearl"));
  assert.ok(dealerBid(silas({ tide: { phase: "high", spring: false } }), "pearl") > dealerBid(silas(), "pearl"));
  assert.equal(dealerBid(silas({ tide: { phase: "low", spring: true } }), "ore"), dealerBid(silas(), "ore"), "ore comes from the cliffs");
});

test("they really compete: with an empty hold he outbids Maren for pearls, with a full one she outbids him", () => {
  const hers = unitBid(maren(), "pearl");
  assert.ok(dealerBid(silas(), "pearl") > hers, `${dealerBid(silas(), "pearl")} vs Maren ${hers}`);
  assert.ok(dealerBid(silas({ stock: { pearl: DEALER_HOLD.pearl } }), "pearl") < hers);
  // and when Maren needs pearls for a beacon she has run out of, she fights back
  const needy = unitBid(maren({ stock: { beacon: 0, pearl: 0 } }), "pearl");
  assert.ok(needy > dealerBid(silas({ stock: { pearl: 1 } }), "pearl"));
});

test("bargaining with him plays out like bargaining with Maren, inside his limits", () => {
  const d = silas();
  const s = openDealerHaggle(d, { token: "pearl", qty: 2 }, () => 0.5);
  assert.ok(s.counter <= s.limit && s.limit <= Math.min(d.ceiling.pearl * 2, d.treasury, d.windowLimit));
  assert.ok(s.limit <= Math.round(s.list * 1.13), "he gives little ground");
  assert.equal(s.patience, 3);
  const r = haggle(s, { type: "accept" });
  assert.deepEqual([r.kind, r.price], ["deal", s.counter]);
  // a push he can live with meets in the middle; a silly one annoys him
  assert.ok(["counter", "deal"].includes(haggle(s, { type: "offer", price: s.counter + 3 }).kind));
  assert.equal(haggle(s, { type: "offer", price: s.counter * 3 }).kind, "insulted");
});

test("he never offers more than his spending window or his purse allows", () => {
  assert.ok(openDealerHaggle(silas({ boughtInWindow: 590 }), { token: "pearl", qty: 3 }, () => 0.5).limit <= 10);
  assert.ok(openDealerHaggle(silas({ treasury: 30 }), { token: "pearl", qty: 3 }, () => 0.5).limit <= 30);
});

test("he ships a full hold to the city, never in a storm, never past the mainland's purse", () => {
  const full = silas({ stock: { ore: 4, pearl: 3 } });
  assert.deepEqual(shipPlan(full, 1000), [
    { token: "ore", qty: 4, pay: 120 },
    { token: "pearl", qty: 3, pay: 246 },
  ]);
  assert.deepEqual(shipPlan(silas({ stock: { ore: 2, pearl: 3 } }), 1000).map((j) => j.token), ["pearl"]);
  // his boat sails at every high tide with whatever is in the hold
  assert.deepEqual(shipPlan(silas({ stock: { ore: 1 }, tide: { phase: "high", spring: false } }), 1000), [{ token: "ore", qty: 1, pay: 30 }]);
  assert.deepEqual(shipPlan(silas({ stock: { ore: 1 }, tide: { phase: "low", spring: false } }), 1000), []);
  assert.deepEqual(shipPlan({ ...full, storm: { active: true } }, 1000), []);
  assert.deepEqual(shipPlan(full, 200).map((j) => j.token), ["ore"]);
});

test("Silas has his own voice, and names his price", () => {
  for (const kind of ["open_buy", "open_buy_keen", "open_buy_glut", "counter", "final", "deal_buy", "charmed", "calledback"]) {
    for (const r of [0, 0.99]) {
      const line = writtenLine(kind, { token: "pearl", qty: 2, price: 7 }, () => r, "silas");
      assert.match(line, /\b7 coins\b/, `${kind}: ${line}`);
      assert.notEqual(line, writtenLine(kind, { token: "pearl", qty: 2, price: 7 }, () => r), "not Maren's line");
    }
  }
  assert.match(writtenLine("wont_buy", {}, () => 0, "silas"), /ore and pearls/);
  assert.match(writtenLine("storm", { passesIn: "3 minutes" }, () => 0, "silas"), /storm passes, about 3 minutes/);
  assert.match(writtenLine("trick", { reason: "above price ceiling" }, () => 0, "silas"), /above price ceiling/);
});

// ---------------- Maren and Silas trading with each other on the board ----------------

const NOW = 1_000_000_000;
const EXPORT = { ...zero, kelp: 2.8, driftwood: 4.2, ore: 21, pearl: 56 };
/// Maren's books with Silas in town, as the server sees them.
const town = (over = {}, dealer = {}) => ({ ...maren(over), exportPrice: EXPORT, dealer: silas(dealer), storm: over.storm });
const notice = (seller, token, qty, unit, agoMs = 60_000) => ({ id: 7, seller, token, qty, unit, listedMs: NOW - agoMs, expiresMs: NOW + 86_400_000 });

test("Maren pins her surplus ore for Silas, priced so he takes the whole lot", () => {
  const m = town({ stock: { ore: 10 } });
  const [n] = marenNotices(m);
  assert.equal(n.token, "ore");
  assert.ok(n.qty >= 1 && n.qty <= 4);
  assert.ok(n.unit > EXPORT.ore, `${n.unit} beats the mainland's ${EXPORT.ore}`);
  const picks = dealerPicks(m.dealer, [notice("maren", n.token, n.qty, n.unit)], NOW, "silas");
  assert.deepEqual(picks.map((p) => [p.token, p.qty]), [["ore", n.qty]]);
  // with a bigger surplus and an emptier, richer Silas she offers more at once
  const flush = town({ stock: { ore: 12 } }, { treasury: 900 });
  flush.dealer.cityPrice.ore = 40;
  assert.ok(marenNotices(flush)[0].qty > n.qty);
});

test("she keeps her ore for the mainland when he would pay less, when he is closed, or when she has no surplus", () => {
  assert.deepEqual(marenNotices(town({ stock: { ore: 10 } }, { stock: { ore: 4 } })), [], "his hold is full: he pays under the export price");
  assert.deepEqual(marenNotices(town({ stock: { ore: 10 }, storm: { active: true } }, { storm: { active: true } })), []);
  assert.deepEqual(marenNotices(town({ stock: { ore: 6 } })), [], "no surplus over her target");
  assert.deepEqual(marenNotices(town({ stock: { ore: 10 } }), { ore: 4 }), [], "one notice per good at a time");
  assert.deepEqual(marenNotices({ ...town({ stock: { ore: 10 } }), dealer: null }), []);
});

test("Silas pins his pearls when Maren would pay more than the city, and she buys them", () => {
  const m = town({ stock: { pearl: 0, beacon: 0 } }, { stock: { pearl: 3 } });
  m.dealer.avgCost = { ...zero, pearl: 60 };
  const [n] = silasNotices(m);
  assert.equal(n.token, "pearl");
  assert.ok(n.unit > m.dealer.cityPrice.pearl && n.qty >= 1, JSON.stringify(n));
  const picks = boardPicks(m, [notice("silas", "pearl", n.qty, n.unit)], NOW, "maren");
  assert.equal(picks[0]?.qty, n.qty, "she takes every one he pinned");
});

test("he ships instead when she pays less than the city, and never sells under cost", () => {
  const normal = town({}, { stock: { pearl: 3 } });
  normal.dealer.avgCost = { ...zero, pearl: 60 };
  assert.deepEqual(silasNotices(normal), []);
  const dear = town({ stock: { pearl: 0, beacon: 0 } }, { stock: { pearl: 3 } });
  dear.dealer.avgCost = { ...zero, pearl: 95 };
  assert.deepEqual(silasNotices(dear), []);
});

test("Silas buys cheap ore and pearls off the board: players first, never his own, within his ceiling", () => {
  const d = silas();
  assert.equal(dealerPicks(d, [notice("guest", "ore", 2, 20)], NOW, "silas")[0]?.qty, 2);
  assert.deepEqual(dealerPicks(d, [notice("guest", "ore", 2, 20, 5_000)], NOW, "silas"), [], "players get first pick");
  assert.deepEqual(dealerPicks(d, [notice("silas", "ore", 2, 20)], NOW, "silas"), [], "not his own");
  assert.deepEqual(dealerPicks(d, [notice("guest", "ore", 2, 45)], NOW, "silas"), [], "over his ceiling");
  assert.deepEqual(dealerPicks(d, [notice("guest", "kelp", 2, 1)], NOW, "silas"), [], "he does not deal in kelp");
  assert.deepEqual(dealerPicks(silas({ storm: { active: true } }), [notice("guest", "ore", 2, 20)], NOW, "silas"), []);
  assert.deepEqual(dealerPicks(silas({ treasury: 30 }), [notice("guest", "ore", 3, 20)], NOW, "silas"), [], "a thin purse makes him stingy");
  assert.deepEqual(dealerPicks(silas({ boughtInWindow: 590 }), [notice("guest", "ore", 3, 20)], NOW, "silas"), [], "within his spending cap");
});

test("promised goods stay: he does not ship them, and old notices come down", () => {
  assert.deepEqual(shipPlan(silas({ stock: { pearl: 3 } }), 1000, { pearl: 3 }), []);
  assert.deepEqual(shipPlan(silas({ stock: { pearl: 5 } }), 1000, { pearl: 2 }).map((j) => j.qty), [3]);
  const listings = [notice("maren", "ore", 4, 22, 1000), notice("maren", "pearl", 1, 90, MERCHANT_NOTICE_MS + 1), notice("guest", "ore", 1, 9)];
  assert.deepEqual(promisedBy(listings, "maren", NOW), { ore: 4, pearl: 1 });
  assert.deepEqual(staleNotices(listings, "maren", NOW).map((l) => l.token), ["pearl"]);
});
