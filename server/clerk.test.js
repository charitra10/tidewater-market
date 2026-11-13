// The clerk who keeps players' shops. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clerkWhy, clerkLeast, clerkShouldReprice, clerkNote, CLERK, SHOP_KINDS, TERMS, unitBid, unitAsk, offerAnswer } from "./merchant.js";
import { tideAt } from "../web/tide.js";

const NOW = 1_794_610_000_000;
const tokens = ["kelp", "driftwood", "ore", "pearl", "rope", "pickaxe", "boat", "beacon"];
const by = (a) => Object.fromEntries(tokens.map((t, i) => [t, a[i]]));
const market = (stock = [9, 8, 4, 4, 3, 2, 1, 1]) => ({
  stock: by(stock),
  avgCost: by([2, 4, 20, 60, 12, 40, 200, 500]),
  treasury: 2000,
  floor: by([2, 3, 15, 40, 12, 35, 150, 400]),
  ceiling: by([8, 12, 60, 160, 40, 120, 600, 1800]),
  tide: tideAt(NOW),
  storm: { active: false },
  event: { kind: null, active: false },
  recent: {},
});

test("raw goods: 30% over the best a merchant pays", () => {
  const m = market();
  const why = clerkWhy(m, { token: "kelp", listedMs: NOW }, NOW);
  assert.equal(why.price, Math.round(unitBid(m, "kelp") * CLERK.rawMarkup));
  assert.match(clerkNote(why), /Maren pays about .*30% more/);
});

test("tools: just under Maren, or their worth when she is sold out", () => {
  const m = market();
  assert.equal(clerkWhy(m, { token: "pickaxe", listedMs: NOW }, NOW).price, Math.round(unitAsk(m, "pickaxe") * 0.9));
  const out = market([9, 8, 4, 4, 3, 0, 1, 1]);
  assert.equal(clerkWhy(out, { token: "pickaxe", listedMs: NOW }, NOW).price, 60);
  assert.equal(clerkWhy(m, { token: "rope", listedMs: NOW }, NOW).price, 20);
});

test("unsold goods get cheaper, to 70%, but never below the owner's floor", () => {
  const m = market();
  const fresh = clerkWhy(m, { token: "pickaxe", listedMs: NOW }, NOW).base;
  assert.equal(clerkWhy(m, { token: "pickaxe", listedMs: NOW - 25 * 60_000 }, NOW).base, fresh * 0.9);
  assert.equal(clerkWhy(m, { token: "pickaxe", listedMs: NOW - 10 * 3600_000 }, NOW).base, fresh * 0.7);
  const floored = clerkWhy(m, { token: "pickaxe", floor: 58, listedMs: NOW - 10 * 3600_000 }, NOW);
  assert.equal(floored.price, 58);
  assert.ok(floored.limits[0].binds);
  for (let i = 0; i < 500; i++) {
    const floor = Math.floor(Math.random() * 100);
    const token = tokens[i % 8];
    const w = clerkWhy(market(), { token, floor, listedMs: NOW - Math.random() * 3600_000 * 3 }, NOW);
    assert.ok(w.price >= floor && w.price >= 1 && Number.isInteger(w.price));
    const least = clerkLeast(w.price, floor);
    assert.ok(least >= floor && least <= w.price);
    const a = offerAnswer({ offer: Math.random() * w.price, ask: w.price, least });
    if (a.answer !== "decline") assert.ok((a.counter ?? Infinity) >= floor);
  }
});

test("the clerk reprices only on a real move, and not too often", () => {
  assert.equal(clerkShouldReprice(10, 10, 0, NOW), false);
  assert.equal(clerkShouldReprice(10, 11, 0, NOW), true);
  assert.equal(clerkShouldReprice(100, 105, 0, NOW), false, "5% is not worth a transaction");
  assert.equal(clerkShouldReprice(10, 12, NOW - 60_000, NOW), false, "repriced a minute ago");
});

test("the shop terms and kinds are the contract's", () => {
  const rust = fs.readFileSync(new URL("../contract/src/lib.rs", import.meta.url), "utf8");
  const kinds = rust.match(/pub const SHOP_KINDS: \[&str; \d+\] = \[([^\]]+)\];/)[1].match(/"([^"]+)"/g).map((k) => k.slice(1, -1));
  assert.deepEqual(SHOP_KINDS, kinds);
  const c = (name) => Number(rust.match(new RegExp(`pub const ${name}: [^=]+= ([^;]+);`))[1].split("*")[0].trim());
  assert.equal(TERMS.pitches, c("MAX_PITCHES"));
  assert.equal(TERMS.pitchRent, c("PITCH_RENT"));
  assert.equal(TERMS.shopNotices, c("MAX_LISTINGS_PER_SHOP"));
});
