// The fast-forward (web/sim-engine.js): the same week for the same seed, the
// contract's yields, guard rails that hold all week, nothing made from thin
// air, and a flood of ore that lowers its price before it recovers. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSim, runFor, step, summary, inject, forageYield, SPOT_ENERGY, BREAK_PCT, DEFAULTS, DAY_MS, STEP_MS } from "../web/sim-engine.js";
import { TOKENS, TARGET, OVERFLOW, bidWhy, unitBid, willTake, dealerWillTake, openHaggle, openDealerHaggle, shipPlan, DEALER_HOLD, DEALER_CRAMMED } from "../web/merchant.js";

const table = JSON.parse(fs.readFileSync(new URL("../contract/tests/fixtures/yields.json", import.meta.url), "utf8"));

test("every trip finds what the contract's forage finds (the shared table)", () => {
  let seed = 1;
  const byte = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  for (const c of table.cases) {
    const lo = Object.fromEntries(TOKENS.map((t) => [t, Infinity]));
    const hi = Object.fromEntries(TOKENS.map((t) => [t, -Infinity]));
    let breaks = 0;
    for (let i = 0; i < 3000; i++) {
      const { found, broke } = forageYield(c.spot, { phase: c.tide, spring: c.spring, storm: c.storm, event: null }, Array.from({ length: 8 }, byte));
      for (const t of TOKENS) (lo[t] = Math.min(lo[t], found[t])), (hi[t] = Math.max(hi[t], found[t]));
      breaks += broke ? 1 : 0;
    }
    for (const t of TOKENS.slice(0, 5)) assert.deepEqual([lo[t], hi[t]], c.yield[t] ?? [0, 0], `${t} on the ${c.spot} (${JSON.stringify(c)})`);
    if (c.spot === "cliffs") {
      const pct = c.storm ? table.pickaxe_break_pct.storm : table.pickaxe_break_pct.calm;
      assert.ok(Math.abs((breaks / 3000) * 100 - pct) < 3, `pickaxes break about ${pct}% of the time (${(breaks / 30).toFixed(1)}%)`);
    }
  }
  assert.deepEqual(SPOT_ENERGY, table.energy);
  assert.deepEqual(BREAK_PCT, table.pickaxe_break_pct);
});

test("the same seed gives the same week, another seed another", () => {
  const run = (seed) => {
    const sim = createSim({ seed });
    runFor(sim, DAY_MS);
    return JSON.stringify([summary(sim), sim.history.at(-1).prices]);
  };
  assert.equal(run(5), run(5));
  assert.notEqual(run(5), run(6));
});

test("a whole week keeps every guard rail and makes nothing from thin air", () => {
  const sim = createSim({ seed: 11 });
  const P = sim.policy;
  for (let i = 0; i < (7 * DAY_MS) / STEP_MS; i++) {
    step(sim);
    if (i % 120) continue; // check every hour
    for (const who of [sim.maren, sim.silas]) {
      assert.ok(who.treasury >= -1e-6, "a treasury never goes below zero");
      for (const t of TOKENS) assert.ok(who.stock[t] >= 0);
    }
    for (const p of sim.players) {
      assert.ok(p.coins >= -1e-6);
      for (const t of TOKENS) assert.ok(p.items[t] >= 0, `${p.id} ${t}`);
    }
    // every item is in a bag, on a shelf, in Silas's hold or on a player's notice
    for (const t of TOKENS) {
      const held = sim.players.reduce((a, p) => a + p.items[t], 0) + sim.maren.stock[t] + sim.silas.stock[t];
      const pinned = sim.board.filter((l) => l.token === t && l.seller !== "maren" && l.seller !== "silas").reduce((a, l) => a + l.qty, 0);
      assert.equal(held + pinned, sim.supply[t], `${t} at step ${i}`);
    }
  }
  assert.ok(sim.ledger.length > 100, "plenty of deals to check");
  for (const d of sim.ledger) {
    const unit = d.total / d.qty;
    if (d.who === "maren" && d.side === "buy") {
      assert.ok(unit <= P.ceiling[d.token] + 1e-9, `Maren paid ${unit} for ${d.token}`);
      assert.ok(d.window <= P.windowLimit + 1e-9, "within her spending cap");
    }
    if (d.who === "maren" && d.side === "sell") assert.ok(unit >= P.floor[d.token] - 1e-9, `Maren sold ${d.token} for ${unit}`);
    if (d.who === "silas") {
      assert.ok(unit <= DEFAULTS.silas.ceiling[d.token] + 1e-9);
      assert.ok(d.window <= DEFAULTS.silas.windowLimit + 1e-9);
    }
  }
});

test("a flood of ore drives its price down, and it recovers", () => {
  const sim = createSim({ seed: 3 });
  runFor(sim, 6 * 3600_000);
  // the best a player can get for a lump: Maren's offer or Silas's
  const best = (s) => Math.max(s.prices.ore, s.silas.ore ?? 0);
  const before = Math.max(...sim.history.slice(-6).map(best));
  inject(sim, "flood");
  runFor(sim, 2 * 3600_000);
  const low = Math.min(...sim.history.slice(-12).map(best));
  assert.ok(low < before * 0.7, `ore fell from ${before} to ${low}`);
  runFor(sim, DAY_MS);
  const later = Math.max(...sim.history.slice(-24).map(best));
  assert.ok(later > low * 1.5, `and came back up (${later})`);
});

test("she stops buying what overflows her shelves, and says why", () => {
  const m = { stock: { ...DEFAULTS.maren.stock, kelp: TARGET.kelp * OVERFLOW }, avgCost: DEFAULTS.maren.avgCost, treasury: 2000, floor: DEFAULTS.policy.floor, ceiling: DEFAULTS.policy.ceiling, recent: {} };
  assert.equal(unitBid(m, "kelp"), 0);
  assert.match(bidWhy(m, "kelp").steps.at(-2).note + bidWhy(m, "kelp").steps.map((s) => s.note).join(" "), /overflowing/);
  assert.ok(unitBid({ ...m, stock: { ...m.stock, kelp: TARGET.kelp * OVERFLOW - 1 } }, "kelp") > 0);
});

test("nobody gets goods for free past an overflowing shelf or a crammed hold", () => {
  const m = { stock: { ...DEFAULTS.maren.stock, kelp: TARGET.kelp * OVERFLOW - 4 }, avgCost: DEFAULTS.maren.avgCost, treasury: 2000, floor: DEFAULTS.policy.floor, ceiling: DEFAULTS.policy.ceiling, recent: {} };
  assert.equal(willTake(m, "kelp", 10), 4);
  const s = openHaggle(m, { side: "buy", token: "kelp", qty: 10 }, () => 0.5);
  assert.equal(s.qty, 4, "she haggles over the 4 she will take");
  const d = { stock: { ore: DEALER_HOLD.ore * DEALER_CRAMMED - 2, pearl: 0 }, treasury: 800, ceiling: { ore: 40, pearl: 100 }, cityPrice: { ore: 30, pearl: 82 } };
  assert.equal(dealerWillTake(d, "ore", 10), 2);
  assert.equal(openDealerHaggle(d, { token: "ore", qty: 10 }, () => 0.5).qty, 2);
});

test("Silas ships what the mainland's purse can pay for, not all or nothing", () => {
  const d = { stock: { ore: 20, pearl: 0 }, cityPrice: { ore: 30, pearl: 82 }, tide: { phase: "high" } };
  assert.deepEqual(shipPlan(d, 100), [{ token: "ore", qty: 3, pay: 90 }]);
  assert.deepEqual(shipPlan(d, 10), []);
});
