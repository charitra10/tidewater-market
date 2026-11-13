// The tide (web/tide.js) and what it does to Maren's offers. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { tideAt, tideHeight, nextTide, tideBidFactor, TIDE_PERIOD_MS, PHASES, mix32, stormAt, stormLevel, stormBidFactor, STORM_BLOCK_MS, STORM_MS, eventAt, eventBidFactor, EVENTS, EVENT_BLOCK_MS } from "../web/tide.js";
import { unitBid, unitAsk, askWhy, priceBoard, openHaggle, boardPicks, planWork, RAW } from "../web/merchant.js";
import { writtenLine, TIDE_WHY } from "./voice.js";

const market = (tide, over = {}) => ({
  stock: { kelp: 3, driftwood: 4, ore: 2, pearl: 1, rope: 3, pickaxe: 2, boat: 0, beacon: 0, ...over.stock },
  avgCost: { kelp: 3, driftwood: 4, ore: 20, pearl: 50, rope: 12, pickaxe: 40, boat: 0, beacon: 0 },
  treasury: over.treasury ?? 1500,
  floor: { kelp: 2, driftwood: 3, ore: 15, pearl: 40, rope: 12, pickaxe: 35, boat: 140, beacon: 350 },
  ceiling: { kelp: 6, driftwood: 9, ore: 42, pearl: 110, rope: 24, pickaxe: 60, boat: 240, beacon: 600 },
  tide,
});
const LOW = { phase: "low", spring: false };
const HIGH = { phase: "high", spring: false };
const SPRING_LOW = { phase: "low", spring: true };
const SPRING_HIGH = { phase: "high", spring: true };

test("the tide turns on the clock exactly as the contract says", () => {
  // the same table as `the_tide_turns_on_the_block_clock` in contract/src/lib.rs
  for (const [ms, phase, spring] of [
    [0, "low", true],
    [149_999, "low", true],
    [150_000, "rising", true],
    [300_000, "high", true],
    [450_000, "falling", true],
    [600_000, "low", false],
    [1_650_000, "falling", false],
    [1_800_000, "low", true],
  ]) {
    const t = tideAt(ms);
    assert.deepEqual([t.phase, t.spring], [phase, spring], `at ${ms} ms`);
  }
  assert.equal(tideAt(1_000_000).endsMs, 1_050_000); // as get_tide's phase_ends_ms
});

test("it can tell you when the next low (or spring low) tide comes", () => {
  assert.equal(nextTide(1_000_000, "low"), 1_200_000);
  assert.equal(nextTide(1_250_000, "low"), 1_200_000); // already low: that one
  assert.equal(nextTide(1_000_000, "low", true), 1_800_000);
  assert.equal(nextTide(1_000_000, "high"), 900_000); // high tide now
  assert.equal(nextTide(1_100_000, "high"), 1_500_000);
  assert.equal(tideAt(nextTide(123_456_789, "high", true)).spring, true);
});

test("the water rises and falls smoothly, lowest at low tide and highest at high tide", () => {
  let last = tideHeight(0);
  let lowest = Infinity;
  let highest = -Infinity;
  for (let ms = 0; ms < TIDE_PERIOD_MS * 6; ms += 1000) {
    const h = tideHeight(ms);
    assert.ok(Math.abs(h - last) < 0.02, `no jumps (at ${ms} ms)`);
    last = h;
    const { phase } = tideAt(ms);
    if (phase === "low") assert.ok(h < -0.7);
    if (phase === "high") assert.ok(h > 0.7);
    if (phase === "rising" || phase === "falling") assert.ok(Math.abs(h) <= 0.71 * 1.35);
    lowest = Math.min(lowest, h);
    highest = Math.max(highest, h);
  }
  assert.ok(lowest < -1.3, "spring lows go lower");
  assert.ok(highest > 1 && highest < 1.35);
});

test("what the tide brings in she pays less for; what it hides she pays more for", () => {
  const plain = market(undefined);
  for (const t of ["kelp", "pearl"]) {
    assert.ok(unitBid(market(LOW), t) < unitBid(plain, t), `${t} at low tide`);
    assert.ok(unitBid(market(HIGH), t) > unitBid(plain, t), `${t} at high tide`);
    assert.ok(unitBid(market(SPRING_LOW), t) < unitBid(market(LOW), t), `${t} at spring low`);
  }
  assert.ok(unitBid(market(LOW), "driftwood") > unitBid(plain, "driftwood"));
  assert.ok(unitBid(market(HIGH), "driftwood") < unitBid(plain, "driftwood"));
  assert.ok(unitBid(market(SPRING_HIGH), "driftwood") < unitBid(market(HIGH), "driftwood"));
  for (const tide of [LOW, HIGH, SPRING_LOW, SPRING_HIGH, { phase: "rising" }, { phase: "falling" }]) {
    assert.equal(unitBid(market(tide), "ore"), unitBid(plain, "ore"), "the cliffs are above the tide");
  }
  for (const phase of ["rising", "falling"]) {
    for (const t of RAW) assert.equal(unitBid(market({ phase, spring: true }), t), unitBid(plain, t));
  }
});

test("over a whole tide her offers average out to about what they were", () => {
  for (const t of RAW) {
    let sum = 0;
    for (const phase of PHASES) sum += tideBidFactor(t, { phase, spring: false });
    assert.ok(Math.abs(sum / 4 - 1) < 0.001, t);
  }
});

test("the tide never pushes her past the ceiling the contract enforces", () => {
  for (const tide of [HIGH, SPRING_HIGH, LOW, SPRING_LOW]) {
    for (const t of RAW) {
      for (let stock = 0; stock < 30; stock++) {
        const m = market(tide, { stock: { [t]: stock, boat: 0, beacon: 0 } });
        assert.ok(unitBid(m, t) <= m.ceiling[t], `${t} at ${tide.phase}${tide.spring ? " (spring)" : ""}, stock ${stock}`);
      }
    }
  }
});

test("the price board, her haggling and her notice-board buying all follow the tide", () => {
  const kelpBid = (tide) => priceBoard(market(tide)).buys.find((b) => b.token === "kelp").price;
  assert.ok(kelpBid(HIGH) > kelpBid(LOW));
  assert.ok(openHaggle(market(HIGH), { side: "buy", token: "kelp", qty: 4 }, () => 0.5).counter > openHaggle(market(LOW), { side: "buy", token: "kelp", qty: 4 }, () => 0.5).counter);
  // a kelp notice priced between her low-tide and high-tide offers: she buys it only when the tide is in
  const price = Math.round((unitBid(market(LOW), "kelp") + unitBid(market(HIGH), "kelp")) / 2);
  const notice = [{ id: 1, seller: "a.testnet", token: "kelp", qty: 1, unit: price, listedMs: 0, expiresMs: 10 ** 12 }];
  assert.equal(boardPicks(market(LOW), notice, 60_000).length, 0);
  assert.equal(boardPicks(market(HIGH), notice, 60_000).length, 1);
});

test("Maren says why the tide moved her offer, and names her price", () => {
  for (const [kind, phase, token] of [
    ["open_buy_tide_cheap", "low", "kelp"],
    ["open_buy_tide_cheap", "high", "driftwood"],
    ["open_buy_tide_dear", "high", "pearl"],
    ["open_buy_tide_dear", "low", "driftwood"],
  ]) {
    for (const r of [0, 0.99]) {
      const line = writtenLine(kind, { token, qty: 2, price: 7, why: TIDE_WHY[phase][token] }, () => r);
      assert.match(line, /\b7 coins\b/);
      assert.ok(line.includes(TIDE_WHY[phase][token]), line);
    }
  }
});

// ---------------- storms ----------------

test("storms come on a public schedule, the same one the contract keeps", () => {
  // the same tables as `storms_come_on_a_public_schedule` in contract/src/lib.rs
  for (const [x, h] of [[0, 2_462_723_854], [1, 920_564_995], [996_968, 2_497_128_548], [4_294_967_295, 996_586_154]]) {
    assert.equal(mix32(x), h, `mix32(${x})`);
  }
  for (const [ms, active, startMs, endsMs] of [
    [0, false, 720_000, 960_000],
    [1_000_000, false, 3_240_000, 3_480_000],
    // a calm hour: the storm due at 1_794_543_000_000 is called off
    [1_794_543_000_000, false, 1_794_544_800_000, 1_794_545_040_000],
    [1_794_544_800_000, true, 1_794_544_800_000, 1_794_545_040_000],
    [1_794_545_039_999, true, 1_794_544_800_000, 1_794_545_040_000],
  ]) {
    assert.deepEqual(stormAt(ms), { active, startMs, endsMs }, `at ${ms} ms`);
  }
  // one storm in every half hour, four minutes long, except the one a calm calls off
  let calms = 0;
  for (let block = 1_000_000; block < 1_000_500; block++) {
    const from = block * STORM_BLOCK_MS;
    const s = stormAt(from);
    const calm = block % 2 === 0 && eventAt(from).kind === "calm";
    if (calm) {
      calms++;
      assert.ok(s.startMs >= from + STORM_BLOCK_MS, "called off: the next storm is in the next half hour");
    } else assert.ok(s.startMs >= from && s.endsMs < from + STORM_BLOCK_MS && s.endsMs - s.startMs === STORM_MS);
  }
  assert.ok(calms > 25 && calms < 75, `${calms} calms`);
});

test("events come on a public schedule, the same one the contract keeps", () => {
  // the same table as `events_come_on_a_public_schedule` in contract/src/lib.rs
  for (const [ms, kind, active, startMs, endsMs] of [
    [0, "fog", false, 600_000, 1_200_000],
    [1_000_000, "fog", true, 600_000, 1_200_000],
    [18_000_001, "festival", false, 18_600_000, 19_200_000],
    [1_794_543_000_000, "calm", true, 1_794_543_000_000, 1_794_543_600_000],
    [1_794_560_000_000, "fog", false, 1_794_560_400_000, 1_794_561_000_000],
  ]) {
    assert.deepEqual(eventAt(ms), { kind, active, startMs, endsMs }, `at ${ms} ms`);
  }
  // one every hour, a whole tide long; a calm always holds off a storm that was due
  for (let hour = 400_000; hour < 400_500; hour++) {
    const e = eventAt(hour * EVENT_BLOCK_MS);
    assert.ok(e.startMs >= hour * EVENT_BLOCK_MS && e.endsMs <= (hour + 1) * EVENT_BLOCK_MS && e.endsMs - e.startMs === TIDE_PERIOD_MS);
    assert.ok(EVENTS.includes(e.kind));
    for (let ms = e.startMs; ms < e.endsMs; ms += 10_000) if (e.kind === "calm") assert.equal(stormAt(ms).active, false);
  }
});

test("a red tide: she won't buy kelp, and nor will the mainland; a festival: lenses dear, pearls wanted", () => {
  const red = { kind: "red_tide", active: true };
  const fest = { kind: "festival", active: true };
  const m = market(undefined, { stock: { kelp: 30 } });
  assert.equal(eventBidFactor("kelp", red), 0);
  assert.equal(eventBidFactor("kelp", { ...red, active: false }), 1);
  assert.equal(unitBid({ ...m, event: red }, "kelp"), 0);
  assert.ok(unitBid({ ...m, event: red }, "driftwood") > 0);
  const row = priceBoard({ ...m, event: red }).buys.find((b) => b.token === "kelp");
  assert.equal(row.price, null, "not buying");
  assert.match(row.why.steps.find((st) => st.key === "event").note, /Red tide/);
  const exports = (event) => planWork({ ...m, event }, { kelp: 3.5 }).filter((j) => j.op === "export" && j.token === "kelp");
  assert.equal(exports(undefined).length, 1);
  assert.equal(exports(red).length, 0);
  // the festival: she asks a quarter more for a lens, and pays a tenth more for pearls
  const shop = market(undefined, { stock: { beacon: 1 } });
  assert.ok(Math.abs(unitAsk({ ...shop, event: fest }, "beacon") / unitAsk(shop, "beacon") - 1.25) < 1e-9);
  assert.ok(unitBid({ ...shop, event: fest }, "pearl") > unitBid(shop, "pearl"));
  assert.match(askWhy({ ...shop, event: fest }, "beacon").steps.find((st) => st.key === "event").note, /festival/);
  // and it never pushes her bid past the ceiling
  assert.ok(unitBid({ ...market(undefined, { stock: { pearl: 0, beacon: 0 }, treasury: 5000 }), event: fest, tide: SPRING_HIGH, storm: { active: true } }, "pearl") <= 110);
});

test("the sky darkens smoothly before a storm and clears after it", () => {
  const s = stormAt(1_794_543_000_000);
  assert.equal(stormLevel(s.startMs - 90_000), 0);
  assert.equal(stormLevel(s.startMs + 1000), 1);
  assert.equal(stormLevel(s.endsMs - 1000), 1);
  assert.equal(stormLevel(s.endsMs + 90_000), 0);
  let last = 0;
  for (let ms = s.startMs - 120_000; ms < s.endsMs + 120_000; ms += 1000) {
    const l = stormLevel(ms);
    assert.ok(Math.abs(l - last) <= 1 / 60 + 1e-9, `no jumps (at ${ms})`);
    last = l;
  }
});

test("in a storm she pays more for pearls and less for driftwood, and ships nothing", () => {
  const calm = { active: false };
  const storm = { active: true };
  const at = (st) => ({ ...market(undefined), storm: st });
  assert.ok(unitBid(at(storm), "pearl") > unitBid(at(calm), "pearl"));
  assert.ok(unitBid(at(storm), "driftwood") < unitBid(at(calm), "driftwood"));
  for (const t of ["kelp", "ore"]) assert.equal(unitBid(at(storm), t), unitBid(at(calm), t));
  assert.equal(stormBidFactor("pearl", undefined), 1);
  // a shelf full of kelp: exported when calm, kept in a storm (but she still crafts)
  const full = { ...market(undefined, { stock: { kelp: 40, rope: 0 } }) };
  const exports = (m) => planWork(m, { kelp: 3, driftwood: 4, ore: 20, pearl: 55 }).filter((j) => j.op === "export");
  assert.ok(exports({ ...full, storm: calm }).length > 0);
  assert.equal(exports({ ...full, storm }).length, 0);
  assert.ok(planWork({ ...full, storm }).some((j) => j.op === "craft"));
  // and never past her ceiling
  for (let stock = 0; stock < 30; stock++) {
    const m = { ...market({ phase: "high", spring: true }, { stock: { pearl: stock, boat: 0, beacon: 0 } }), storm };
    assert.ok(unitBid(m, "pearl") <= m.ceiling.pearl);
  }
});

test("Maren blames the storm, and names her price", () => {
  for (const [kind, token] of [["open_buy_tide_dear", "pearl"], ["open_buy_tide_cheap", "driftwood"]]) {
    for (const r of [0, 0.99]) {
      const line = writtenLine(kind, { token, qty: 1, price: 9, why: TIDE_WHY.storm[token] }, () => r);
      assert.match(line, /\b9 coins\b/);
      assert.ok(line.includes(TIDE_WHY.storm[token]), line);
    }
  }
});
