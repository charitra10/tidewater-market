// The fast-forward: a week of Tidewater trading, simulated in the browser (or
// in node, for the tests and scripts/simulate.mjs). No transactions: it copies
// the contract's rules and calls the very same pricing code the live merchants
// use (merchant.js), so what you watch here is what the live market would do.
//
// What is copied from the contract (contract/src/lib.rs) and kept honest by tests:
//   - what each forage trip finds, and how often a pickaxe breaks: the table in
//     contract/tests/fixtures/yields.json, which the contract is also tested against;
//   - energy, recipes, notice lifetimes, the shut-and-reopen levels and IOU terms
//     (the numbers in TERMS, which a test reads out of lib.rs);
//   - every guard rail on a deal: floors, ceilings, spending caps, treasuries.
// Seeded and deterministic: the same seed and settings give the same week.

import {
  TOKENS, RAW, WARES, TARGET, RECIPES, VALUE, TERMS, DEALER_TOKENS,
  unitAsk, unitBid, listPrice, willTake, dealerWillTake, planWork, boardPicks, recentDemand, dealerBid,
  shipPlan, marenNotices, silasNotices, dealerPicks, promisedBy, staleNotices, orderPlan, staleOrders, mainlandShare,
} from "./merchant.js";
import { tideAt, stormAt, eventAt } from "./tide.js";

export const STEP_MS = 30_000; // one step of game time
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SAMPLE_MS = 10 * 60_000; // the charts take a sample every ten minutes
export const ENERGY_MAX = 12;
export const ENERGY_REGEN_MS = 6000;
export const SPOT_ENERGY = { shore: 1, cliffs: 2, reef: 3 };
export const BREAK_PCT = { calm: 12, storm: 25 };
export const NOTICE_TTL_MS = DAY_MS;
export const PLAYER_NOTICES = 3;
export const STARTING_COINS = 29; // what a guest has to spend when they step ashore
/// How busy a player is while online: one trip at most per step (walking to the
/// spot, back to the stall and the board takes time), and not every step.
export const BUSY = 0.4;

/// The market as the bootstrap script sets it up (scripts/init-args.mjs and
/// add-dealer.sh), for when the live market can't be read.
export const DEFAULTS = {
  maren: {
    stock: { kelp: 9, driftwood: 8, ore: 4, pearl: 4, rope: 3, pickaxe: 2, boat: 1, beacon: 1 },
    avgCost: { kelp: 2, driftwood: 3, ore: 18, pearl: 50, rope: 9, pickaxe: 30, boat: 130, beacon: 330 },
    treasury: 2500,
  },
  policy: {
    floor: { kelp: 2, driftwood: 3, ore: 15, pearl: 40, rope: 12, pickaxe: 35, boat: 140, beacon: 350 },
    ceiling: { kelp: 6, driftwood: 9, ore: 42, pearl: 110, rope: 24, pickaxe: 60, boat: 240, beacon: 600 },
    exportPrice: { kelp: 2.8, driftwood: 4.2, ore: 21, pearl: 56, rope: 0, pickaxe: 0, boat: 0, beacon: 0 },
    windowLimit: 1500,
    windowMs: 600_000,
  },
  silas: {
    stock: { ore: 0, pearl: 0 },
    avgCost: { ore: 0, pearl: 0 },
    treasury: 800,
    ceiling: { ore: 40, pearl: 100 },
    cityPrice: { ore: 30, pearl: 82 },
    windowLimit: 600,
    windowMs: 600_000,
  },
  mainland: 500,
};

/// Players and what they do. Each kind plays a few hours a day, at its own times.
export const KINDS = {
  beachcomber: "combs the shore and sells at once",
  "tide-timer": "gathers at low water, sells at high",
  miner: "buys or makes a pickaxe, sells ore to whoever pays more",
  diver: "saves for a boat, holds pearls for the storms",
  flipper: "buys cheap notices and pins them again dearer",
  investor: "backs a merchant who has shut, and collects",
  "beacon-chaser": "saves up for the lens and lights the lighthouse",
};
const MIX = ["beachcomber", "tide-timer", "miner", "diver", "flipper", "investor", "beacon-chaser", "beachcomber", "miner", "tide-timer"];

// ---------------------------------------------------------------------------
// A seeded random number generator (mulberry32)
// ---------------------------------------------------------------------------
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The contract's forage, copied (checked against contract/tests/fixtures/yields.json)
// ---------------------------------------------------------------------------
/// What one trip finds. `r` is 8 random bytes, as the contract takes from its hash.
export function forageYield(spot, { phase, spring, storm, event }, r) {
  const found = Object.fromEntries(TOKENS.map((t) => [t, 0]));
  let broke = false;
  const [a, b] = r;
  if (spot === "shore" && storm) {
    found.kelp = 1 + (a % 3);
    found.driftwood = 2 + (b % 4);
    found.pearl = r[3] % 8 === 0 ? 1 : 0;
  } else if (spot === "shore") {
    if (phase === "low") [found.kelp, found.driftwood] = [(spring ? 3 : 2) + (a % 3), b % 2];
    else if (phase === "high") [found.kelp, found.driftwood] = [1 + (a % 2), (spring ? 2 : 1) + (b % 3)];
    else [found.kelp, found.driftwood] = [1 + (a % 3), b % 3];
  } else if (spot === "cliffs") {
    found.ore = 1 + (a % 2);
    found.driftwood = b % 2;
    broke = r[2] % 100 < (storm ? BREAK_PCT.storm : BREAK_PCT.calm);
  } else {
    if (phase === "low") found.pearl = spring ? [1, 2, 2, 3][a % 4] : 1 + (a % 2);
    else if (phase === "high") found.pearl = spring ? (a % 4 === 0 ? 1 : 0) : a % 2;
    else found.pearl = [0, 1, 1, 2][a % 4];
    found.kelp = 1 + (b % 2);
  }
  if (event === "red_tide") found.kelp = 0;
  else if (event === "fog" && spot === "reef") found.pearl = r[4] % 2 === 0 ? 0 : 2 * found.pearl + 1;
  else if (event === "calm" && spot === "reef") found.pearl += 1;
  else if (event === "shipwreck" && spot === "shore") {
    found.rope += r[5] % 3 === 0 ? 1 : 0;
    found.ore += r[6] % 6 === 0 ? 1 : 0;
    found.boat += r[7] % 50 === 0 ? 1 : 0;
  }
  return { found, broke };
}

// ---------------------------------------------------------------------------
// Setting up a week
// ---------------------------------------------------------------------------
const zeros = () => Object.fromEntries(TOKENS.map((t) => [t, 0]));
const clone = (o) => JSON.parse(JSON.stringify(o));

/// A new simulation. `seed` makes it repeatable; `from` is the starting market
/// (the live one, from /api/sim-seed, or DEFAULTS); `start` the clock (ms).
export function createSim({ seed = 1, players = 8, from = DEFAULTS, start = 1_794_600_000_000, mainlandPerDay = 6000 } = {}) {
  const rng = rngFrom(seed);
  const m = clone(from.maren);
  const s = clone(from.silas ?? DEFAULTS.silas); // (no Silas in town: he stays away all week)
  const sim = {
    seed,
    start,
    t: start,
    rng,
    policy: clone(from.policy),
    maren: {
      stock: { ...zeros(), ...m.stock },
      cost: Object.fromEntries(TOKENS.map((t) => [t, (m.avgCost[t] ?? 0) * (m.stock[t] ?? 0)])),
      treasury: m.treasury,
      profit: 0,
      boughtInWindow: 0,
      windowStart: start,
      closed: m.treasury < TERMS.closeBelow,
      closures: 0,
      ious: [],
    },
    silas: {
      here: Boolean(from.silas),
      stock: { ...zeros(), ...s.stock },
      cost: Object.fromEntries(TOKENS.map((t) => [t, (s.avgCost?.[t] ?? 0) * (s.stock?.[t] ?? 0)])),
      treasury: s.treasury,
      profit: 0,
      boughtInWindow: 0,
      windowStart: start,
      ceiling: s.ceiling,
      cityPrice: s.cityPrice,
      windowLimit: s.windowLimit,
      windowMs: s.windowMs,
      closed: s.treasury < TERMS.closeBelow,
      closures: 0,
      ious: [],
    },
    mainland: from.mainland,
    mainlandPerDay,
    board: [], // notices: { id, seller, token, qty, unit, listedMs, expiresMs }
    orders: [], // Maren's wanted orders: { id, token, qty, unit, for, expiresMs }
    nextId: 1,
    trades: [], // her recent deals, for the demand term: { side, token, qty, at }
    players: [],
    supply: zeros(),
    flags: { stormSeasonUntil: 0, goldRushUntil: 0, noInvest: false, boatStopped: false },
    floods: [], // ore someone is dumping on the market: { left }
    story: [],
    history: [],
    counts: { trades: 0, refused: 0, exports: 0, crafted: 0, beacons: 0, closures: 0, invested: 0, repaid: 0, forages: 0, broken: 0, boardSales: 0, ordersFilled: 0 },
    lastSample: 0,
    // where the coins went: Maren buying raw goods and selling wares, exports, Silas
    flow: { marenPaid: 0, marenTook: 0, exports: 0, silasPaid: 0, silasShipped: 0 },
    // every deal at a counter, for checking the guard rails: { who, side, token, qty, total, t }
    ledger: [],
  };
  for (const t of TOKENS) sim.supply[t] = sim.maren.stock[t] + sim.silas.stock[t];
  for (let i = 0; i < players; i++) {
    const kind = MIX[i % MIX.length];
    sim.players.push({
      id: `p${i + 1}`,
      kind,
      coins: STARTING_COINS,
      items: zeros(),
      energy: ENERGY_MAX,
      // a few hours a day online, at a time of its own
      online: { from: Math.floor(rng() * 24), hours: 1 + Math.floor(rng() * 4) },
      invested: 0,
      credit: 0,
      lit: false,
    });
  }
  record(sim, "start", `The week begins: Maren holds ${Math.round(sim.maren.treasury)} coins, Silas ${Math.round(sim.silas.treasury)}, the mainland's purse ${Math.round(sim.mainland)}; ${players} players come ashore.`);
  sample(sim);
  return sim;
}

// ---------------------------------------------------------------------------
// The clock and the weather (as the contract sees it, plus any injected events)
// ---------------------------------------------------------------------------
function weather(sim, t = sim.t) {
  const tide = tideAt(t);
  let storm = stormAt(t);
  // storm season: a storm for six minutes in every fifteen, on top of the usual ones
  if (t < sim.flags.stormSeasonUntil && Math.floor(t / 60_000) % 15 < 6) storm = { ...storm, active: true };
  const ev = eventAt(t);
  return { tide, storm, event: ev, phase: tide.phase, spring: tide.spring, stormy: storm.active, eventKind: ev.active ? ev.kind : null };
}

/// Maren's books as merchant.js expects them (the same shape the server builds).
export function marketView(sim, t = sim.t) {
  const w = weather(sim, t);
  const M = sim.maren;
  const avgCost = Object.fromEntries(TOKENS.map((k) => [k, M.stock[k] ? M.cost[k] / M.stock[k] : 0]));
  const S = sim.silas;
  return {
    stock: { ...M.stock },
    avgCost,
    treasury: M.treasury,
    floor: sim.policy.floor,
    ceiling: sim.policy.ceiling,
    exportPrice: sim.policy.exportPrice,
    mainland: sim.mainland,
    boughtInWindow: t - M.windowStart < sim.policy.windowMs ? M.boughtInWindow : 0,
    windowLimit: sim.policy.windowLimit,
    tide: w.tide,
    storm: w.storm,
    event: w.event,
    recent: recentDemand(sim.trades, t),
    shop: { closed: M.closed },
    frozen: false,
    dealer: S.here
      ? {
          stock: { ...S.stock },
          avgCost: Object.fromEntries(TOKENS.map((k) => [k, S.stock[k] ? S.cost[k] / S.stock[k] : 0])),
          treasury: S.treasury,
          ceiling: S.ceiling,
          cityPrice: S.cityPrice,
          windowLimit: S.windowLimit,
          boughtInWindow: t - S.windowStart < S.windowMs ? S.boughtInWindow : 0,
          tide: w.tide,
          storm: w.storm,
          shop: { closed: S.closed },
        }
      : null,
  };
}

function record(sim, kind, text, extra = {}) {
  sim.story.push({ t: sim.t, kind, text, ...extra });
}

// ---------------------------------------------------------------------------
// Deals, under the contract's guard rails
// ---------------------------------------------------------------------------
function rollWindow(sim, who) {
  const ms = who === sim.silas ? who.windowMs : sim.policy.windowMs;
  if (sim.t - who.windowStart >= ms) {
    who.windowStart = sim.t;
    who.boughtInWindow = 0;
  }
}
function takeStock(who, t, qty) {
  const avg = who.stock[t] ? who.cost[t] / who.stock[t] : 0;
  const out = avg * qty;
  who.stock[t] -= qty;
  who.cost[t] = Math.max(0, who.cost[t] - out);
  return out;
}
/// 30% of a merchant's margin repays their IOUs, oldest first (the contract's `earned`).
function earned(sim, who, margin) {
  if (margin <= 0 || !who.ious.length) return;
  let pool = Math.min((margin * TERMS.repayPct) / 100, who.treasury);
  for (const iou of who.ious) {
    if (pool <= 0) break;
    const x = Math.min(iou.owed - iou.repaid, pool);
    iou.repaid += x;
    pool -= x;
    who.treasury -= x;
    iou.player.coins += x; // (collected straight away: investors collect as soon as there is something)
    sim.counts.repaid += x;
  }
  who.ious = who.ious.filter((i) => i.repaid < i.owed - 1e-9);
}
/// Shut below 150, open again at 400 (the contract's `settle_shops`).
function settle(sim) {
  for (const [who, name] of [[sim.maren, "Maren"], [sim.silas, "Silas"]]) {
    if (!who.closed && who.treasury < TERMS.closeBelow) {
      who.closed = true;
      who.closures += 1;
      sim.counts.closures += 1;
      record(sim, "shut", `${name}'s purse is down to ${Math.floor(who.treasury)}: ${name === "Maren" ? "she shuts her stall" : "he goes to the city to raise money"}.`, { who: name });
    } else if (who.closed && who.treasury >= TERMS.reopenAt) {
      who.closed = false;
      record(sim, "open", `${name} is open again.`, { who: name });
    }
  }
}

/// A player sells raw goods to Maren at her list price, if the guard rails allow. Returns coins.
function sellToMaren(sim, p, token, qty) {
  const M = sim.maren;
  if (M.closed || qty <= 0) return 0;
  const market = marketView(sim);
  if (!(unitBid(market, token) > 0)) return 0;
  rollWindow(sim, M);
  // the most of the lot she may buy: what fits her shelves, her ceiling, her treasury and her spending cap
  for (let q = willTake(market, token, qty); q > 0; q--) {
    const total = listPrice(market, "buy", token, q);
    if (total > sim.policy.ceiling[token] * q || total > M.treasury || M.boughtInWindow + total > sim.policy.windowLimit) {
      sim.counts.refused += q === qty ? 1 : 0;
      continue;
    }
    p.items[token] -= q;
    p.coins += total;
    M.stock[token] += q;
    M.cost[token] += total;
    M.treasury -= total;
    M.boughtInWindow += total;
    sim.flow.marenPaid += total;
    sim.ledger.push({ who: "maren", side: "buy", token, qty: q, total, t: sim.t, window: M.boughtInWindow });
    sim.trades.push({ side: "sold", token, qty: q, at: sim.t, total });
    sim.counts.trades += 1;
    settle(sim);
    return total;
  }
  return 0;
}
/// A player buys a ware from Maren at her asking price. Returns true if they did.
function buyFromMaren(sim, p, token) {
  const M = sim.maren;
  if (M.closed || M.stock[token] < 1) return false;
  const free = M.stock[token] - (promisedBy(sim.board, "maren", sim.t)[token] ?? 0);
  if (free < 1) return false;
  const total = listPrice(marketView(sim), "sell", token, 1);
  if (total < sim.policy.floor[token] || total > p.coins) return false;
  const costOut = takeStock(M, token, 1);
  p.coins -= total;
  p.items[token] += 1;
  M.treasury += total;
  sim.flow.marenTook += total;
  sim.ledger.push({ who: "maren", side: "sell", token, qty: 1, total, t: sim.t });
  M.profit += total - costOut;
  earned(sim, M, total - costOut);
  sim.trades.push({ side: "bought", token, qty: 1, at: sim.t, total });
  sim.counts.trades += 1;
  settle(sim);
  return true;
}
/// A player sells ore or pearls to Silas at his offer. Returns coins.
function sellToSilas(sim, p, token, qty) {
  const S = sim.silas;
  const market = marketView(sim);
  if (!S.here || S.closed || qty <= 0 || !market.dealer || market.storm.active) return 0;
  rollWindow(sim, S);
  for (let q = dealerWillTake({ ...market.dealer, treasury: S.treasury }, token, qty); q > 0; q--) {
    let total = 0;
    for (let i = 0; i < q; i++) total += dealerBid({ ...market.dealer, treasury: S.treasury }, token, S.stock[token] + i);
    total = Math.max(1, Math.round(total));
    if (total > S.ceiling[token] * q || total > S.treasury || S.boughtInWindow + total > S.windowLimit) continue;
    p.items[token] -= q;
    p.coins += total;
    sim.flow.silasPaid += total;
    sim.ledger.push({ who: "silas", side: "buy", token, qty: q, total, t: sim.t, window: S.boughtInWindow + total });
    S.stock[token] += q;
    S.cost[token] += total;
    S.treasury -= total;
    S.boughtInWindow += total;
    sim.counts.trades += 1;
    settle(sim);
    return total;
  }
  return 0;
}
/// Who pays more for one unit right now: { who: "maren" | "silas" | null, price }.
function bestBuyer(sim, token) {
  const market = marketView(sim);
  const her = sim.maren.closed ? 0 : unitBid(market, token);
  const his = DEALER_TOKENS.includes(token) && market.dealer && !sim.silas.closed && !market.storm.active ? dealerBid(market.dealer, token) : 0;
  if (her <= 0 && his <= 0) return { who: null, price: 0 };
  return his > her ? { who: "silas", price: his } : { who: "maren", price: her };
}
function sellBest(sim, p, token, qty = p.items[token]) {
  if (qty <= 0) return 0;
  // one of her wanted orders pays more than her counter
  const o = sim.orders.find((x) => x.token === token && x.qty > 0 && sim.t <= x.expiresMs);
  if (o && !sim.maren.closed && o.unit * Math.min(qty, o.qty) <= sim.maren.treasury) {
    const q = Math.min(qty, o.qty);
    const total = o.unit * q;
    rollWindow(sim, sim.maren);
    if (sim.maren.boughtInWindow + total <= sim.policy.windowLimit && o.unit <= sim.policy.ceiling[token]) {
      p.items[token] -= q;
      p.coins += total;
      sim.maren.stock[token] += q;
      sim.maren.cost[token] += total;
      sim.maren.treasury -= total;
      sim.maren.boughtInWindow += total;
      o.qty -= q;
      sim.trades.push({ side: "sold", token, qty: q, at: sim.t, total });
      sim.counts.trades += 1;
      sim.counts.ordersFilled += 1;
      settle(sim);
      qty -= q;
      if (qty <= 0) return total;
    }
  }
  const best = bestBuyer(sim, token);
  if (best.who === "silas") return sellToSilas(sim, p, token, qty) || sellToMaren(sim, p, token, qty);
  if (best.who === "maren") return sellToMaren(sim, p, token, qty);
  return 0;
}

// ---------------------------------------------------------------------------
// The notice board
// ---------------------------------------------------------------------------
function pin(sim, seller, token, qty, unit) {
  if (sim.board.filter((l) => l.seller === seller).length >= PLAYER_NOTICES) return null;
  const l = { id: sim.nextId++, seller, token, qty, unit: Math.max(1, Math.round(unit)), listedMs: sim.t, expiresMs: sim.t + NOTICE_TTL_MS };
  sim.board.push(l);
  return l;
}
const playerById = (sim, id) => sim.players.find((x) => x.id === id);
/// Close a sale off notice `l`: `qty` to the buyer, the coins to the seller.
function closeSale(sim, l, buyer, qty) {
  const total = l.unit * qty;
  l.qty -= qty;
  if (l.qty <= 0) sim.board = sim.board.filter((x) => x !== l);
  if (l.seller === "maren") {
    const costOut = takeStock(sim.maren, l.token, qty);
    sim.maren.treasury += total;
    sim.maren.profit += total - costOut;
    earned(sim, sim.maren, total - costOut);
  } else if (l.seller === "silas") {
    const costOut = takeStock(sim.silas, l.token, qty);
    sim.silas.treasury += total;
    sim.silas.profit += total - costOut;
    earned(sim, sim.silas, total - costOut);
  } else playerById(sim, l.seller).coins += total;
  if (buyer === "maren") {
    sim.maren.stock[l.token] += qty;
    sim.maren.cost[l.token] += total;
    sim.maren.treasury -= total;
    sim.maren.boughtInWindow += total;
  } else if (buyer === "silas") {
    sim.silas.stock[l.token] += qty;
    sim.silas.cost[l.token] += total;
    sim.silas.treasury -= total;
    sim.silas.boughtInWindow += total;
  } else {
    const p = playerById(sim, buyer);
    p.coins -= total;
    p.items[l.token] += qty;
  }
  sim.counts.boardSales += 1;
  settle(sim);
}
function sweepBoard(sim) {
  for (const l of sim.board.filter((x) => sim.t > x.expiresMs)) {
    if (l.seller !== "maren" && l.seller !== "silas") playerById(sim, l.seller).items[l.token] += l.qty;
  }
  sim.board = sim.board.filter((x) => sim.t <= x.expiresMs);
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------
function online(sim, p) {
  if (p.kind === "flooder") return true;
  const hour = Math.floor(((sim.t - sim.start) % DAY_MS) / 3_600_000);
  return (hour - p.online.from + 24) % 24 < p.online.hours;
}
function forage(sim, p, spot) {
  const w = weather(sim);
  if (p.energy < SPOT_ENERGY[spot]) return false;
  if (spot === "reef" && (w.stormy || p.items.boat < 1)) return false;
  if (spot === "cliffs" && p.items.pickaxe < 1) return false;
  p.energy -= SPOT_ENERGY[spot];
  const r = Array.from({ length: 8 }, () => Math.floor(sim.rng() * 256));
  const { found, broke } = forageYield(spot, { phase: w.phase, spring: w.spring, storm: w.stormy, event: w.eventKind }, r);
  if (spot === "reef" && sim.t < sim.flags.goldRushUntil) found.pearl *= 2;
  for (const t of TOKENS) {
    p.items[t] += found[t];
    sim.supply[t] += found[t];
  }
  if (broke) {
    p.items.pickaxe -= 1;
    sim.supply.pickaxe -= 1;
    sim.counts.broken += 1;
  }
  sim.counts.forages += 1;
  return true;
}
/// The workbench: rope from 3 kelp (1 energy), a pickaxe from 2 driftwood and a rope (2 energy).
function makePickaxe(sim, p) {
  if (p.items.rope < 1 && p.items.kelp >= 3 && p.energy >= 1) {
    p.items.kelp -= 3;
    p.items.rope += 1;
    p.energy -= 1;
    sim.supply.kelp -= 3;
    sim.supply.rope += 1;
  }
  if (p.items.rope >= 1 && p.items.driftwood >= 2 && p.energy >= 2) {
    p.items.rope -= 1;
    p.items.driftwood -= 2;
    p.items.pickaxe += 1;
    p.energy -= 2;
    sim.supply.rope -= 1;
    sim.supply.driftwood -= 2;
    sim.supply.pickaxe += 1;
    return true;
  }
  return false;
}
/// Sell what they carry, unless nobody pays a fair price for it today: then
/// they hold on to it (a player sees the price before they haggle).
export const HOLD_BELOW = 0.4;
function sellRaw(sim, p, only = RAW) {
  for (const t of only) {
    if (p.items[t] <= 0) continue;
    if (bestBuyer(sim, t).price < VALUE[t] * 0.62 * HOLD_BELOW && !sim.orders.some((o) => o.token === t && o.qty > 0)) continue;
    sellBest(sim, p, t);
  }
}
/// Nobody wants what this place gives right now, and they already hold plenty.
const glutted = (sim, p, token) => p.items[token] >= 10 && bestBuyer(sim, token).price < VALUE[token] * 0.62 * HOLD_BELOW;
function buyCheapNotice(sim, p, token, most) {
  const l = sim.board.filter((x) => x.token === token && x.seller !== p.id && sim.t - x.listedMs >= 0 && x.unit <= most && x.unit <= p.coins).sort((a, b) => a.unit - b.unit)[0];
  if (!l) return false;
  closeSale(sim, l, p.id, 1);
  return true;
}

function act(sim, p) {
  const w = weather(sim);
  const market = () => marketView(sim);
  switch (p.kind) {
    case "beachcomber":
      forage(sim, p, "shore");
      sellRaw(sim, p);
      break;
    case "tide-timer":
      if (w.phase === "low" || w.phase === "rising") forage(sim, p, "shore");
      // kelp at high water (fewer people bring it in), everything else straight away
      if (w.phase === "high" || w.phase === "falling") sellRaw(sim, p);
      else sellRaw(sim, p, ["ore", "pearl"]);
      break;
    case "miner":
    case "diver":
    case "beacon-chaser": {
      // the arc: a pickaxe, then a boat (the diver and the chaser), then the lens (the chaser)
      if (p.items.pickaxe < 1 && !buyCheapNotice(sim, p, "pickaxe", 0.9 * unitAsk(market(), "pickaxe")) && !buyFromMaren(sim, p, "pickaxe")) makePickaxe(sim, p);
      if (p.kind !== "miner" && p.items.boat < 1 && p.coins >= unitAsk(market(), "boat")) buyCheapNotice(sim, p, "boat", unitAsk(market(), "boat")) || buyFromMaren(sim, p, "boat");
      if (p.kind === "beacon-chaser" && !p.lit && p.items.beacon < 1 && p.coins >= unitAsk(market(), "beacon")) buyFromMaren(sim, p, "beacon");
      if (p.items.beacon > 0 && !p.lit) {
        p.items.beacon -= 1;
        sim.supply.beacon -= 1;
        p.lit = true;
        sim.counts.beacons += 1;
        record(sim, "beacon", `${p.id} (${p.kind}) lights the lighthouse.`);
      }
      // one trip: the richest place they can reach
      // (and not where nobody buys what they would find)
      if (!(p.items.boat > 0 && !w.stormy && !glutted(sim, p, "pearl") && forage(sim, p, "reef")) && !(p.items.pickaxe > 0 && !glutted(sim, p, "ore") && forage(sim, p, "cliffs"))) forage(sim, p, "shore");
      // the diver holds pearls for a storm, when the reef is shut and they pay best
      const keep = p.kind === "diver" && !w.stormy && p.items.pearl < 8 ? ["kelp", "driftwood", "ore"] : RAW;
      // goods for the next tool are kept, not sold
      sellRaw(sim, p, keep.filter((t) => !(p.items.pickaxe < 1 && (t === "kelp" || t === "driftwood") && p.coins < unitAsk(market(), "pickaxe"))));
      break;
    }
    case "flipper": {
      forage(sim, p, "shore");
      // buy what is pinned under what the merchants pay, pin it again dearer
      for (const t of RAW) {
        const best = bestBuyer(sim, t).price;
        if (best > 0 && buyCheapNotice(sim, p, t, best * 0.85)) pin(sim, p.id, t, 1, best * 1.15) && (p.items[t] -= 1);
      }
      // the rest: pinned a little over the best offer, or sold
      for (const t of RAW) {
        const best = bestBuyer(sim, t).price;
        if (p.items[t] > 0 && best > 0 && pin(sim, p.id, t, p.items[t], best * 1.2)) p.items[t] = 0;
      }
      sellRaw(sim, p);
      break;
    }
    case "investor": {
      forage(sim, p, "shore");
      sellRaw(sim, p);
      for (const who of [sim.maren, sim.silas]) {
        if (!who.closed || sim.flags.noInvest || p.coins < TERMS.minInvest + 5 || (who === sim.silas && !sim.silas.here)) continue;
        const put = Math.min(TERMS.maxInvest, Math.floor(p.coins * 0.7));
        p.coins -= put;
        who.treasury += put;
        who.ious.push({ player: p, put, owed: (put * TERMS.iouReturnPct) / 100, repaid: 0 });
        p.invested += put;
        sim.counts.invested += put;
        record(sim, "invest", `${p.id} invests ${put} in ${who === sim.maren ? "Maren" : "Silas"}.`, { who: who === sim.maren ? "Maren" : "Silas", coins: put });
        settle(sim);
      }
      break;
    }
    case "flooder": {
      // an injected event: someone dumps a pile of ore, as much as anyone will take
      sellBest(sim, p, "ore");
      if (p.items.ore === 0) p.kind = "gone";
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// The merchants between customers (the server's workshop, with the same rules)
// ---------------------------------------------------------------------------
function workshop(sim) {
  const M = sim.maren;
  const S = sim.silas;
  const now = sim.t;
  // notices nobody took come down
  for (const who of ["maren", "silas"]) for (const l of staleNotices(sim.board, who, now)) sim.board = sim.board.filter((x) => x !== l);
  if (!M.closed) {
    // wanted orders
    const open = sim.orders.filter((o) => o.qty > 0 && now <= o.expiresMs);
    const stale = new Set(staleOrders(marketView(sim), open));
    sim.orders = open.filter((o) => !stale.has(o));
    for (const o of orderPlan(marketView(sim), sim.orders, now)) {
      if (o.unit > sim.policy.ceiling[o.token]) continue;
      sim.orders.push({ id: sim.nextId++, token: o.token, qty: o.qty, unit: o.unit, for: o.for, expiresMs: o.expiresMs });
      record(sim, "order", `Maren wants ${o.qty} ${o.token} for a ${o.for}, ${o.unit} each until high tide.`);
    }
    // craft and export (promised goods stay)
    const promised = promisedBy(sim.board, "maren", now);
    const view = marketView(sim);
    const free = Object.fromEntries(TOKENS.map((t) => [t, M.stock[t] - (promised[t] ?? 0)]));
    for (const job of planWork({ ...view, stock: free }, sim.policy.exportPrice).slice(0, 3)) {
      if (job.op === "craft") {
        for (let i = 0; i < job.qty; i++) {
          const needs = RECIPES[job.token];
          if (!Object.entries(needs).every(([t, n]) => M.stock[t] >= n)) break;
          let costIn = 0;
          for (const [t, n] of Object.entries(needs)) {
            costIn += takeStock(M, t, n);
            sim.supply[t] -= n;
          }
          M.stock[job.token] += 1;
          M.cost[job.token] += costIn;
          sim.supply[job.token] += 1;
          sim.counts.crafted += 1;
        }
      } else {
        // as many as her share of the mainland's purse pays for (half is Silas's while he trades)
        const qty = Math.min(job.qty, M.stock[job.token], Math.floor(mainlandShare(sim.mainland, S.here && !S.closed) / sim.policy.exportPrice[job.token]));
        if (qty < 1 || weather(sim).stormy) continue;
        const pay = sim.policy.exportPrice[job.token] * qty;
        const costOut = takeStock(M, job.token, qty);
        sim.supply[job.token] -= qty;
        sim.mainland -= pay;
        sim.flow.exports += pay;
        M.treasury += pay;
        M.profit += pay - costOut;
        earned(sim, M, pay - costOut);
        sim.counts.exports += 1;
      }
    }
    // she buys cheap notices off the board, under her guard rails
    rollWindow(sim, M);
    for (const pick of boardPicks(marketView(sim), sim.board, now, "maren").slice(0, 3)) {
      const l = sim.board.find((x) => x.id === pick.id);
      if (!l || pick.total > M.treasury || M.boughtInWindow + pick.total > sim.policy.windowLimit || l.unit > sim.policy.ceiling[l.token]) continue;
      closeSale(sim, l, "maren", pick.qty);
    }
    // surplus ore and pearls pinned for Silas
    if (S.here && !S.closed) for (const n of marenNotices(marketView(sim), promisedBy(sim.board, "maren", now))) if (n.unit >= sim.policy.floor[n.token]) pin(sim, "maren", n.token, n.qty, n.unit);
  }
  if (S.here && !S.closed) {
    const view = marketView(sim);
    for (const n of silasNotices(view, promisedBy(sim.board, "silas", now))) pin(sim, "silas", n.token, n.qty, n.unit);
    rollWindow(sim, S);
    for (const pick of dealerPicks(marketView(sim).dealer, sim.board, now, "silas").slice(0, 3)) {
      const l = sim.board.find((x) => x.id === pick.id);
      if (!l || pick.total > S.treasury || S.boughtInWindow + pick.total > S.windowLimit || l.unit > S.ceiling[l.token]) continue;
      closeSale(sim, l, "silas", pick.qty);
    }
    for (const job of shipPlan(marketView(sim).dealer, mainlandShare(sim.mainland, !M.closed), promisedBy(sim.board, "silas", now))) {
      const costOut = takeStock(S, job.token, job.qty);
      sim.supply[job.token] -= job.qty;
      sim.mainland -= job.pay;
      sim.flow.silasShipped += job.pay;
      S.treasury += job.pay;
      S.profit += job.pay - costOut;
      earned(sim, S, job.pay - costOut);
    }
  }
  settle(sim);
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------
/// Advance one step (30 seconds of game time).
export function step(sim) {
  sim.t += STEP_MS;
  if (!sim.flags.boatStopped) sim.mainland += (sim.mainlandPerDay * STEP_MS) / DAY_MS;
  sim.trades = sim.trades.filter((x) => sim.t - x.at < 10 * 60_000);
  sweepBoard(sim);
  for (const p of sim.players) {
    p.energy = Math.min(ENERGY_MAX, p.energy + STEP_MS / ENERGY_REGEN_MS);
    if (p.kind !== "gone" && online(sim, p) && (p.kind === "flooder" || sim.rng() < BUSY)) act(sim, p);
  }
  workshop(sim);
  if (sim.t - sim.lastSample >= SAMPLE_MS) sample(sim);
}

/// Run until `ms` of game time has passed since the start (or `steps` steps).
export function runFor(sim, ms) {
  const end = sim.t + ms;
  while (sim.t < end) step(sim);
}

/// A sample for the charts: prices, stock, purses, and the books behind them
/// (so hovering a moment can show the working, with the same why-functions).
function sample(sim) {
  sim.lastSample = sim.t;
  const market = marketView(sim);
  const prices = {};
  for (const t of WARES) prices[t] = Math.round(unitAsk(market, t));
  for (const t of RAW) prices[t] = Math.round(unitBid(market, t) * 10) / 10;
  const silas = {};
  if (market.dealer) for (const t of DEALER_TOKENS) silas[t] = Math.round(dealerBid(market.dealer, t) * 10) / 10;
  // the turns worth telling: a merchant stops buying a good, or starts again
  // (at most once every three hours for each good, so the story stays readable)
  sim.glut ??= {};
  for (const t of RAW) {
    const g = (sim.glut[t] ??= { open: false, told: -Infinity });
    const name = t === "pearl" ? "pearls" : t;
    if (!g.open && prices[t] === 0 && market.stock[t] >= TARGET[t] * 5 && sim.t - g.told >= 3 * 3600_000) {
      record(sim, "glut", `Maren's shelves overflow with ${name} (${market.stock[t]}): she stops buying until the mainland boat takes some.`);
      g.open = true;
      g.told = sim.t;
    } else if (g.open && prices[t] > 0 && sim.t - g.told >= 3 * 3600_000) {
      record(sim, "unglut", `Maren is buying ${name} again, at ${prices[t]}.`);
      g.open = false;
    }
  }
  sim.history.push({
    t: sim.t,
    prices,
    silas,
    stock: { ...sim.maren.stock },
    maren: Math.round(sim.maren.treasury),
    silasPurse: Math.round(sim.silas.treasury),
    mainland: Math.round(sim.mainland),
    pockets: Math.round(sim.players.reduce((a, p) => a + p.coins, 0)),
    closed: { maren: sim.maren.closed, silas: sim.silas.closed || !sim.silas.here },
    storm: market.storm.active,
    event: market.event.active ? market.event.kind : null,
    books: { stock: { ...market.stock }, avgCost: market.avgCost, treasury: market.treasury, recent: market.recent, boughtInWindow: market.boughtInWindow, dealer: market.dealer && { stock: { ...market.dealer.stock }, treasury: market.dealer.treasury } },
  });
}

// ---------------------------------------------------------------------------
// Things to throw at it while it runs
// ---------------------------------------------------------------------------
export const SHOCKS = {
  flood: "Flood the market with ore (someone dumps 150)",
  storms: "Storm season (a day of extra storms)",
  goldrush: "Gold rush (reef pearls doubled for a day)",
  noinvest: "Nobody invests any more",
  boat: "The mainland boat stops (no more exports)",
  silas: "Silas leaves town",
};
export function inject(sim, shock) {
  if (shock === "flood") {
    const p = { id: `flood${sim.nextId++}`, kind: "flooder", coins: 0, items: { ...zeros(), ore: 150 }, energy: 0, online: { from: 0, hours: 24 }, invested: 0, credit: 0, lit: false };
    sim.players.push(p);
    sim.supply.ore += 150;
    record(sim, "shock", "Someone dumps 150 lumps of ore on the market.");
  } else if (shock === "storms") {
    sim.flags.stormSeasonUntil = sim.t + DAY_MS;
    record(sim, "shock", "Storm season: a day of extra storms.");
  } else if (shock === "goldrush") {
    sim.flags.goldRushUntil = sim.t + DAY_MS;
    record(sim, "shock", "Gold rush: the reef gives twice the pearls for a day.");
  } else if (shock === "noinvest") {
    sim.flags.noInvest = true;
    record(sim, "shock", "Nobody will invest in a merchant any more.");
  } else if (shock === "boat") {
    sim.flags.boatStopped = true;
    sim.mainland = 0;
    record(sim, "shock", "The mainland boat stops coming: no more exports.");
  } else if (shock === "silas") {
    sim.silas.here = false;
    sim.board = sim.board.filter((l) => l.seller !== "silas");
    record(sim, "shock", "Silas leaves town.");
  }
}

// ---------------------------------------------------------------------------
// The week in numbers
// ---------------------------------------------------------------------------
export function summary(sim) {
  const h = sim.history;
  const range = (f) => {
    const v = h.map(f).filter((x) => x != null && !Number.isNaN(x));
    return v.length ? [Math.min(...v), Math.max(...v)] : [0, 0];
  };
  const prices = {};
  for (const t of [...RAW, ...WARES]) prices[t] = range((s) => s.prices[t]);
  const invested = sim.players.reduce((a, p) => a + p.invested, 0);
  return {
    days: (sim.t - sim.start) / DAY_MS,
    prices,
    silas: Object.fromEntries(DEALER_TOKENS.map((t) => [t, range((s) => s.silas[t])])),
    closures: { maren: sim.maren.closures, silas: sim.silas.closures },
    invested,
    repaid: Math.round(sim.counts.repaid),
    beacons: sim.counts.beacons,
    trades: sim.counts.trades,
    boardSales: sim.counts.boardSales,
    ordersFilled: sim.counts.ordersFilled,
    crafted: sim.counts.crafted,
    exports: sim.counts.exports,
    forages: sim.counts.forages,
    pickaxesBroken: sim.counts.broken,
    money: {
      maren: Math.round(sim.maren.treasury),
      silas: Math.round(sim.silas.treasury),
      mainland: Math.round(sim.mainland),
      pockets: Math.round(sim.players.reduce((a, p) => a + p.coins, 0)),
    },
  };
}
