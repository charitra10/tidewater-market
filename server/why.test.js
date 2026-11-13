// Tests for the reasons behind every price (the tooltip at the stall) and for
// recent demand. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  askWhy, bidWhy, dealerBidWhy, unitAsk, unitBid, dealerBid, priceBoard, dealerBoard, recentDemand, demandFactor, haggleWhy, openHaggle, haggle,
  marenNotices, silasNotices, TARGET, VALUE, RECIPES, RAW, WARES, COMFORTABLE, DEALER_HOLD, DEALER_COMFORTABLE, DEMAND_SWING, DEMAND_HALF_LIFE_MS, DEMAND_WINDOW_MS,
} from "./merchant.js";
import { tideBidFactor, stormBidFactor, PHASES } from "../web/tide.js";

const FLOOR = { kelp: 2, driftwood: 3, ore: 15, pearl: 40, rope: 12, pickaxe: 35, boat: 140, beacon: 350 };
const CEILING = { kelp: 6, driftwood: 9, ore: 42, pearl: 110, rope: 24, pickaxe: 60, boat: 240, beacon: 600 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A small seeded random number generator, so a failure can be replayed.
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/// A random but plausible state of her books, tide, storm and recent trades.
function randomMarket(r, { recent = true } = {}) {
  const stock = {};
  const avgCost = {};
  for (const t of Object.keys(TARGET)) {
    stock[t] = int(r, 0, TARGET[t] * 3);
    avgCost[t] = r() < 0.2 ? 0 : VALUE[t] * (0.3 + r() * 0.9);
  }
  const m = {
    stock,
    avgCost,
    treasury: r() < 0.2 ? int(r, 0, 300) : int(r, 300, 3000),
    floor: FLOOR,
    ceiling: CEILING,
    tide: r() < 0.1 ? undefined : { phase: pick(r, PHASES), spring: r() < 0.33 },
    storm: { active: r() < 0.2 },
  };
  if (recent && r() < 0.7) {
    m.recent = {};
    for (const t of Object.keys(TARGET)) if (r() < 0.5) m.recent[t] = { bought: r() * 6, sold: r() * 20, boughtN: int(r, 1, 6), soldN: int(r, 1, 20) };
  }
  return m;
}

// The price rules exactly as they were before the reasons were added, kept here
// so the refactor provably changed nothing when there is no recent demand.
function oldAsk(m, token, stock = m.stock[token]) {
  const target = TARGET[token];
  const scarcity = clamp(1 + (0.6 * (target - stock)) / target, 0.8, 1.6);
  const wantsCash = m.treasury < COMFORTABLE * 0.5 ? 0.92 : 1;
  return Math.max(VALUE[token] * scarcity * wantsCash, (m.avgCost[token] ?? 0) * 1.15, m.floor[token] ?? 0);
}
function oldBid(m, token, stock = m.stock[token]) {
  const target = TARGET[token];
  let need = clamp(1 + (0.5 * (target - stock)) / target, 0.55, 1.5);
  const s = { ...m.stock, [token]: stock };
  for (const [out, needs] of Object.entries(RECIPES)) {
    if (needs[token] && s[out] < TARGET[out] && s[token] < needs[token]) {
      need *= 1.15;
      break;
    }
  }
  const cash = clamp(m.treasury / COMFORTABLE, 0.35, 1);
  const weather = tideBidFactor(token, m.tide) * stormBidFactor(token, m.storm);
  return Math.min(VALUE[token] * 0.62 * need * cash * weather, m.ceiling[token] ?? Infinity);
}
function oldDealerBid(d, token, stock = d.stock[token]) {
  const city = d.cityPrice[token] ?? 0;
  if (!city || d.storm?.active) return 0;
  const appetite = clamp(1.05 - (0.5 * stock) / DEALER_HOLD[token], 0.3, 1.05);
  const cash = clamp(d.treasury / DEALER_COMFORTABLE, 0.3, 1);
  return Math.min(city * 0.78 * appetite * cash * tideBidFactor(token, d.tide), city * 0.95, d.ceiling[token] ?? Infinity);
}
function randomDealer(r) {
  return {
    stock: { ore: int(r, 0, 6), pearl: int(r, 0, 5) },
    treasury: r() < 0.2 ? int(r, 0, 150) : int(r, 150, 1500),
    ceiling: { ore: r() < 0.3 ? 20 : 40, pearl: r() < 0.3 ? 50 : 100 },
    cityPrice: { ore: 30, pearl: 82 },
    tide: { phase: pick(r, PHASES), spring: r() < 0.33 },
    storm: { active: r() < 0.15 },
  };
}

/// Multiply a breakdown's steps back together.
const product = (why) => why.steps.reduce((acc, s) => (s.value !== undefined ? s.value : acc * s.factor), 1);

test("with no recent demand, every price is exactly what the old rules gave", () => {
  const r = rng(1);
  for (let i = 0; i < 3000; i++) {
    const m = randomMarket(r, { recent: false });
    for (const t of WARES) for (const s of [0, 1, 2, m.stock[t]]) assert.equal(unitAsk(m, t, s), oldAsk(m, t, s), `ask ${t} at ${s}`);
    for (const t of RAW) for (const s of [0, 3, m.stock[t]]) assert.equal(unitBid(m, t, s), oldBid(m, t, s), `bid ${t} at ${s}`);
    const d = randomDealer(r);
    for (const t of ["ore", "pearl"]) assert.equal(dealerBid(d, t), oldDealerBid(d, t), `dealer ${t}`);
  }
});

test("each breakdown's price is the price, and its steps multiply out to the price before the limits", () => {
  const r = rng(2);
  for (let i = 0; i < 3000; i++) {
    const m = randomMarket(r);
    for (const t of WARES) {
      const w = askWhy(m, t);
      assert.equal(w.price, unitAsk(m, t));
      assert.ok(Math.abs(product(w) - w.base) < 1e-9 * Math.max(1, w.base), `ask ${t}: ${product(w)} vs ${w.base}`);
    }
    for (const t of RAW) {
      const w = bidWhy(m, t);
      assert.equal(w.price, unitBid(m, t));
      assert.ok(Math.abs(product(w) - w.base) < 1e-9 * Math.max(1, w.base), `bid ${t}: ${product(w)} vs ${w.base}`);
    }
    const d = randomDealer(r);
    for (const t of ["ore", "pearl"]) {
      const w = dealerBidWhy(d, t);
      assert.equal(w.price, dealerBid(d, t));
      if (!d.storm.active) assert.ok(Math.abs(product(w) - w.base) < 1e-9 * Math.max(1, w.base), `dealer ${t}`);
    }
  }
});

test("`capped` is set exactly when a floor or ceiling bites, and names the one that did", () => {
  const r = rng(3);
  let seen = { ask: 0, bid: 0, dealer: 0 };
  for (let i = 0; i < 3000; i++) {
    const m = randomMarket(r);
    for (const t of WARES) {
      const w = askWhy(m, t);
      const bites = Math.max(m.avgCost[t] * 1.15, m.floor[t]) > w.base;
      assert.equal(w.capped, bites, `ask ${t}`);
      assert.equal(w.limits.filter((l) => l.binds).length, bites ? 1 : 0);
      if (bites) assert.equal(w.limits.find((l) => l.binds).value, w.price), seen.ask++;
    }
    for (const t of RAW) {
      const w = bidWhy(m, t);
      assert.equal(w.capped, w.base > m.ceiling[t], `bid ${t}`);
      assert.equal(w.limits[0].binds, w.capped);
      if (w.capped) seen.bid++;
    }
    const d = randomDealer(r);
    for (const t of ["ore", "pearl"]) {
      const w = dealerBidWhy(d, t);
      const bites = !d.storm.active && w.base > Math.min(d.cityPrice[t] * 0.95, d.ceiling[t]);
      assert.equal(w.capped, bites, `dealer ${t}`);
      assert.equal(w.limits.filter((l) => l.binds).length, bites ? 1 : 0);
      if (bites) seen.dealer++;
    }
  }
  // the random states really did reach every limit
  assert.ok(seen.ask > 0 && seen.bid > 0 && seen.dealer > 0, JSON.stringify(seen));
});

test("the price boards carry the reasons for the prices they show", () => {
  const r = rng(4);
  for (let i = 0; i < 300; i++) {
    const m = randomMarket(r);
    const b = priceBoard(m);
    for (const row of b.sells) {
      if (row.stock === 0) assert.equal(row.why, null);
      else assert.equal(row.price, Math.max(1, Math.round(row.why.price)));
    }
    for (const row of b.buys) assert.equal(row.price, Math.max(1, Math.round(row.why.price)));
    for (const row of dealerBoard(randomDealer(r))) assert.equal(row.price, Math.round(row.why.price));
  }
});

test("every step has words, and the tide and storm say what they do", () => {
  const m = randomMarket(rng(5), { recent: false });
  m.tide = { phase: "low", spring: true };
  m.storm = { active: false };
  const kelp = bidWhy(m, "kelp");
  for (const s of kelp.steps) assert.ok(s.note && s.note.length > 5, JSON.stringify(s));
  assert.match(kelp.steps.find((s) => s.key === "tide").note, /Low tide: everyone is bringing this in \(a spring tide/);
  assert.match(bidWhy(m, "ore").steps.find((s) => s.key === "tide").note, /cliffs/);
  const stormy = bidWhy({ ...m, storm: { active: true } }, "pearl");
  assert.equal(stormy.steps.find((s) => s.key === "storm").factor, 1.25);
  const silas = dealerBidWhy({ ...randomDealer(rng(6)), storm: { active: true } }, "pearl");
  assert.equal(silas.price, 0);
  assert.match(silas.steps[0].note, /battened down/);
});

// ---------------- recent demand ----------------

const NOW = 1_800_000_000_000;
const trade = (side, token, qty, ago) => ({ side, token, qty, at: NOW - ago });

test("recent demand halves every five minutes and forgets trades older than a tide", () => {
  const r = recentDemand([trade("sold", "ore", 4, 0), trade("sold", "ore", 4, DEMAND_HALF_LIFE_MS), trade("bought", "pickaxe", 1, 60_000), trade("sold", "ore", 9, DEMAND_WINDOW_MS)], NOW);
  assert.ok(Math.abs(r.ore.sold - 6) < 1e-9); // 4 + 4 × ½, and the old 9 not at all
  assert.equal(r.ore.soldN, 8);
  assert.equal(r.ore.bought, 0);
  assert.equal(r.pickaxe.boughtN, 1);
  assert.ok(r.pickaxe.bought < 1 && r.pickaxe.bought > 0.8);
  assert.deepEqual(recentDemand([], NOW), {});
  // a trade stamped a moment "in the future" (clocks differ) counts as just now
  assert.equal(recentDemand([trade("sold", "kelp", 2, -500)], NOW).kelp.sold, 2);
});

test("demand stays inside its bounds: bids at most 25% lower, asks at most 25% higher", () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const t = pick(r, Object.keys(TARGET));
    const m = { recent: { [t]: { bought: r() * 1000, sold: r() * 1000 } } };
    const bid = demandFactor(m, "bid", t);
    const ask = demandFactor(m, "ask", t);
    assert.ok(bid > 1 - DEMAND_SWING - 1e-12 && bid <= 1, `bid ${bid}`);
    assert.ok(ask >= 1 && ask < 1 + DEMAND_SWING + 1e-12, `ask ${ask}`);
  }
  assert.equal(demandFactor({}, "bid", "ore"), 1);
});

test("a burst of ore sold to her lowers her ore bid, and it recovers as the burst is forgotten", () => {
  const m = randomMarket(rng(8), { recent: false });
  Object.assign(m, { tide: { phase: "rising", spring: false }, storm: { active: false }, treasury: 2000 });
  m.stock.ore = 5;
  const calm = unitBid(m, "ore");
  const burst = [trade("sold", "ore", 3, 0), trade("sold", "ore", 3, 30_000), trade("sold", "ore", 2, 60_000)];
  const at = (later) => unitBid({ ...m, recent: recentDemand(burst, NOW + later) }, "ore");
  assert.ok(at(0) < calm * 0.85, `${at(0)} vs ${calm}`);
  assert.ok(at(0) < at(4 * 60_000) && at(4 * 60_000) < at(8 * 60_000) && at(8 * 60_000) < calm);
  assert.equal(at(DEMAND_WINDOW_MS + 60_000), calm); // a tide later it has no effect at all
  // and the tooltip says so, in words
  const why = bidWhy({ ...m, recent: recentDemand(burst, NOW) }, "ore");
  assert.match(why.steps.find((s) => s.key === "demand").note, /sold her 8 in the last 10 minutes/);
});

test("players buying her pickaxes raises her ask, but never her bid past the ceiling", () => {
  const m = randomMarket(rng(9), { recent: false });
  Object.assign(m, { treasury: 2000 });
  m.stock.pickaxe = 2;
  m.avgCost.pickaxe = 30;
  const before = unitAsk(m, "pickaxe");
  const busy = { ...m, recent: recentDemand([trade("bought", "pickaxe", 1, 0), trade("bought", "pickaxe", 1, 90_000)], NOW) };
  assert.ok(unitAsk(busy, "pickaxe") > before * 1.1);
  assert.match(askWhy(busy, "pickaxe").steps.find((s) => s.key === "demand").note, /Players bought 2/);
  // the demand term never lifts a bid over the on-chain ceiling (it only ever lowers bids anyway)
  const r = rng(10);
  for (let i = 0; i < 2000; i++) {
    const mm = randomMarket(r);
    for (const t of RAW) assert.ok(unitBid(mm, t) <= mm.ceiling[t]);
  }
});

// ---------------- notices and haggling ----------------

test("the merchants' notices say why they were pinned", () => {
  const m = randomMarket(rng(11), { recent: false });
  Object.assign(m, { storm: { active: false }, tide: { phase: "rising", spring: false }, exportPrice: { ore: 21, pearl: 56 } });
  Object.assign(m.stock, { ore: 12, pearl: 0, beacon: 0 });
  Object.assign(m.avgCost, { ore: 10 });
  m.dealer = { stock: { ore: 0, pearl: 3 }, avgCost: { pearl: 50 }, treasury: 800, ceiling: { ore: 40, pearl: 100 }, cityPrice: { ore: 30, pearl: 82 }, tide: m.tide, storm: m.storm };
  const [ore] = marenNotices(m);
  assert.equal(ore.token, "ore");
  assert.match(ore.why, /Silas would pay \d+ each; the mainland pays only 21/);
  const [pearl] = silasNotices(m);
  assert.equal(pearl.token, "pearl");
  assert.match(pearl.why, /Maren would pay \d+ each, because she needs them for a beacon lens\. The city pays Silas only 82/);
});

test("a haggle's reasons never give away her limit, or any number at all", () => {
  const m = randomMarket(rng(12), { recent: false });
  m.stock.pickaxe = 2;
  const kinds = new Set();
  for (let seed = 0; seed < 200; seed++) {
    const r = rng(seed);
    let s = openHaggle(m, { side: "sell", token: "pickaxe", qty: 1, trades: int(r, 0, 20), mood: int(r, -2, 2) }, r);
    const lines = [haggleWhy("open", s, { trades: 20 }), haggleWhy("open", s, { trades: 5, who: "silas" })];
    for (let i = 0; i < 6 && !s.over; i++) {
      const move = pick(r, [{ type: "offer", price: int(r, 1, s.counter) }, { type: "walk" }, { type: "charm" }]);
      const res = haggle(s, move);
      s = res.session;
      kinds.add(res.kind);
      lines.push(haggleWhy(res.kind, s), haggleWhy(res.kind, s, { who: "silas" }));
    }
    for (const line of lines) assert.doesNotMatch(line, /\d/, line);
  }
  for (const k of ["counter", "insulted", "final", "calledback", "charmed"]) assert.ok(haggleWhy(k, { mood: 0 }).length > 10, k);
  assert.match(haggleWhy("open", { qty: 1 }, { trades: 7 }), /regular/);
  assert.match(haggleWhy("insulted", {}, { who: "silas" }), /insulted him/);
  assert.ok(kinds.size >= 4, [...kinds].join());
});
