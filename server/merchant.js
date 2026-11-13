// Maren's head for business. Pure functions and one small state machine: no
// network, no chain. Prices come from what is on her shelves, what she paid
// for it, how much coin she has and what players have been buying and selling
// lately, so the economy moves by itself. Every price comes with its working
// (askWhy, bidWhy, dealerBidWhy), which the game shows when you hover a price.
//
// All prices here are whole "coins" (1 coin = 0.001 NEAR).

import { tideBidFactor, stormBidFactor } from "../web/tide.js";

export const TOKENS = ["kelp", "driftwood", "ore", "pearl", "rope", "pickaxe", "boat", "beacon"];
export const RAW = ["kelp", "driftwood", "ore", "pearl"]; // she buys these
export const WARES = ["pickaxe", "boat", "beacon"]; // she sells these

/// What a thing is worth on a quiet day.
export const VALUE = { kelp: 4, driftwood: 6, ore: 30, pearl: 80, rope: 20, pickaxe: 60, boat: 240, beacon: 600 };
/// How many of each she likes to keep on the shelves.
export const TARGET = { kelp: 9, driftwood: 8, ore: 4, pearl: 4, rope: 3, pickaxe: 2, boat: 1, beacon: 1 };
export const RECIPES = {
  rope: { kelp: 3 },
  pickaxe: { driftwood: 2, rope: 1 },
  boat: { driftwood: 4, rope: 2, ore: 2 },
  beacon: { pearl: 3, ore: 2, rope: 1 },
};
/// Treasury (in coins) at which she feels comfortable.
export const COMFORTABLE = 600;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/// `market`: { stock: {token: n}, avgCost: {token: coins}, treasury: coins,
///             floor: {token: coins}, ceiling: {token: coins},
///             tide?: { phase, spring }, storm?: { active } (see web/tide.js) }

// ---------------------------------------------------------------------------
// Recent demand: what players have been buying from her and selling to her
// ---------------------------------------------------------------------------

/// How fast a burst of trading is forgotten: its weight halves every 5 minutes,
/// and trades older than one tide (10 minutes) are not counted at all. The
/// contract keeps her last 40 trades, so the window is "the last 40 trades or
/// one tide, whichever is shorter".
export const DEMAND_HALF_LIFE_MS = 5 * 60_000;
export const DEMAND_WINDOW_MS = 10 * 60_000;
/// The most demand can move a price: asks up to 25% higher, bids up to 25% lower.
/// Kept modest, because her stock already moves with every trade.
export const DEMAND_SWING = 0.25;

/// Tally her recent trades. `trades`: [{ side: "bought" | "sold", token, qty, at }],
/// where `side` is what the PLAYER did. Returns { token: { bought, sold, boughtN, soldN } }:
/// the decayed amounts that move prices, and plain counts for the words.
export function recentDemand(trades, now) {
  const out = {};
  for (const t of trades) {
    const age = Math.max(0, now - t.at);
    if (age >= DEMAND_WINDOW_MS || !(t.qty > 0)) continue;
    const r = (out[t.token] ??= { bought: 0, sold: 0, boughtN: 0, soldN: 0 });
    const w = 0.5 ** (age / DEMAND_HALF_LIFE_MS);
    if (t.side === "bought") (r.bought += t.qty * w), (r.boughtN += t.qty);
    else if (t.side === "sold") (r.sold += t.qty * w), (r.soldN += t.qty);
  }
  return out;
}

/// How recent demand moves her price for `token`: "ask" rises when players have
/// been buying it, "bid" falls when they have been selling it to her. A lot as
/// big as her usual stock moves it about two thirds of the way to the limit.
export function demandFactor(market, side, token) {
  const r = market.recent?.[token];
  const amount = side === "ask" ? r?.bought : r?.sold;
  if (!amount) return 1;
  const pull = DEMAND_SWING * (1 - Math.exp(-amount / TARGET[token]));
  return side === "ask" ? 1 + pull : 1 - pull;
}

// ---------------------------------------------------------------------------
// Her prices, with their reasons
//
// Each price function returns its working: { price, base, steps, limits, capped }.
//   steps:  [{ key, value | factor, note }], multiplied in order to give `base`
//   limits: [{ key, value, binds, note }], the hard rules applied after that
//   capped: true when a limit moved the price away from `base`
// The tooltip at the stall shows exactly this, so it can never disagree with
// the price she quotes: unitAsk, unitBid and dealerBid just return `.price`.
// ---------------------------------------------------------------------------

const n1 = (v) => String(Math.round(v * 10) / 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const minutes = (ms) => Math.round(ms / 60_000);

function shelfNote(stock, target, place = "her shelf", likes = "she likes") {
  if (stock <= 0) return `None on ${place}; ${likes} to keep ${target}`;
  if (stock < target) return `Only ${stock} on ${place}; ${likes} to keep ${target}`;
  if (stock === target) return `${stock} on ${place}, just what ${likes} to keep`;
  return `${stock} on ${place}, more than the ${target} ${likes} to keep`;
}

function tideNote(token, tide, factor) {
  if (!tide) return null;
  if (token === "ore") return "Ore comes from the cliffs, above the tide";
  const name = { low: "Low tide", high: "High tide", rising: "Tide rising", falling: "Tide going out" }[tide.phase] ?? "The tide";
  if (factor === 1) return `${name}: no effect on this`;
  const spring = tide.spring ? " (a spring tide, so more so)" : "";
  return factor < 1 ? `${name}: everyone is bringing this in${spring}` : `${name}: hardly anyone can bring this in${spring}`;
}

/// Her asking price for ONE unit when `stock` of it are left on the shelf, with its reasons.
export function askWhy(market, token, stock = market.stock[token]) {
  const target = TARGET[token];
  const scarcity = clamp(1 + (0.6 * (target - stock)) / target, 0.8, 1.6);
  const short = market.treasury < COMFORTABLE * 0.5;
  const wantsCash = short ? 0.92 : 1;
  const demand = demandFactor(market, "ask", token);
  const bought = market.recent?.[token]?.boughtN ?? 0;
  const steps = [
    { key: "worth", value: VALUE[token], note: `Worth ${VALUE[token]} on a quiet day` },
    { key: "shelf", factor: scarcity, note: shelfNote(stock, target) },
    { key: "purse", factor: wantsCash, note: short ? `Her purse is under ${COMFORTABLE * 0.5}, so she'll take a little less to raise cash` : "Her purse is healthy" },
    { key: "demand", factor: demand, note: bought ? `Players bought ${bought} in the last ${minutes(DEMAND_WINDOW_MS)} minutes: in demand` : "Nobody has bought one lately" },
  ];
  const base = VALUE[token] * scarcity * wantsCash * demand;
  const costFloor = (market.avgCost[token] ?? 0) * 1.15;
  const floor = market.floor[token] ?? 0;
  // never below what it cost her plus a margin, never below the on-chain floor
  const price = Math.max(base, costFloor, floor);
  const limits = [
    { key: "cost", value: costFloor, binds: price > base && price === costFloor, note: `Never below what it cost her (${n1(market.avgCost[token] ?? 0)}) plus 15%` },
    { key: "floor", value: floor, binds: price > base && price === floor && price !== costFloor, note: `The ledger won't let her sell below ${n1(floor)}` },
  ];
  return { price, base, steps, limits, capped: price !== base };
}

/// Her asking price for ONE unit when `stock` of it are left on the shelf.
export function unitAsk(market, token, stock = market.stock[token]) {
  return askWhy(market, token, stock).price;
}

/// The thing she has run out of and needs this raw good to make, if any.
function neededFor(market, token) {
  for (const [out, needs] of Object.entries(RECIPES)) {
    if (needs[token] && market.stock[out] < TARGET[out] && market.stock[token] < needs[token]) return out;
  }
  return null;
}

/// What she offers for ONE unit when she already holds `stock` of it, with its reasons.
export function bidWhy(market, token, stock = market.stock[token]) {
  const target = TARGET[token];
  const steps = [
    { key: "worth", value: VALUE[token], note: `Worth ${VALUE[token]} on a quiet day` },
    { key: "cut", factor: 0.62, note: "She offers 62% of that, to leave room for her margin" },
  ];
  let need = clamp(1 + (0.5 * (target - stock)) / target, 0.55, 1.5);
  steps.push({ key: "shelf", factor: need, note: shelfNote(stock, target) });
  const out = neededFor({ ...market, stock: { ...market.stock, [token]: stock } }, token);
  if (out) {
    need *= 1.15;
    steps.push({ key: "needed", factor: 1.15, note: `She needs it to make a ${out === "beacon" ? "beacon lens" : out}, and she's out of them` });
  }
  const cash = clamp(market.treasury / COMFORTABLE, 0.35, 1);
  steps.push({ key: "purse", factor: cash, note: cash < 1 ? `Her purse is down to ${Math.floor(market.treasury)}, so she pays less` : "Her purse is healthy" });
  // everyone brings kelp in at low tide, nobody at high tide; nobody brings pearls in a storm
  const tide = tideBidFactor(token, market.tide);
  const storm = stormBidFactor(token, market.storm);
  const tNote = tideNote(token, market.tide, tide);
  if (tNote) steps.push({ key: "tide", factor: tide, note: tNote });
  if (storm !== 1) {
    steps.push({ key: "storm", factor: storm, note: storm > 1 ? "Storm: the reef is shut, so nobody can fetch pearls" : "Storm: the shore is covered in wrack" });
  }
  const demand = demandFactor(market, "bid", token);
  const sold = market.recent?.[token]?.soldN ?? 0;
  steps.push({ key: "demand", factor: demand, note: sold ? `Players sold her ${sold} in the last ${minutes(DEMAND_WINDOW_MS)} minutes` : "Nobody has sold her any lately" });
  const base = VALUE[token] * 0.62 * need * cash * (tide * storm) * demand;
  const ceiling = market.ceiling[token] ?? Infinity;
  const price = Math.min(base, ceiling);
  const limits = [{ key: "ceiling", value: ceiling, binds: base > ceiling, note: `The ledger won't let her pay more than ${n1(ceiling)}` }];
  return { price, base, steps, limits, capped: price !== base };
}

/// What she offers for ONE unit when she already holds `stock` of it.
export function unitBid(market, token, stock = market.stock[token]) {
  return bidWhy(market, token, stock).price;
}

/// Her opening price for a lot. Each unit is priced as the shelf changes, so
/// big lots get dearer to buy and cheaper to sell.
export function listPrice(market, side, token, qty) {
  let total = 0;
  for (let i = 0; i < qty; i++) {
    total += side === "sell" ? unitAsk(market, token, market.stock[token] - i) : unitBid(market, token, market.stock[token] + i);
  }
  return Math.max(1, Math.round(total));
}

/// The price board shown to players.
export function priceBoard(market) {
  return {
    sells: WARES.map((token) => {
      const why = market.stock[token] > 0 ? askWhy(market, token) : null;
      return { token, stock: market.stock[token], price: why ? Math.max(1, Math.round(why.price)) : null, why };
    }),
    buys: RAW.map((token) => {
      const why = bidWhy(market, token);
      return { token, stock: market.stock[token], price: Math.max(1, Math.round(why.price)), why };
    }),
  };
}

/// What she should do in the workshop right now: a list of
/// { op: "craft" | "export", token, qty }.
export function planWork(market, exportPrice = {}) {
  const stock = { ...market.stock };
  const jobs = [];
  // rope first (it goes into everything), then the wares players are waiting for
  for (const out of ["rope", "pickaxe", "boat", "beacon"]) {
    const needs = RECIPES[out];
    while (stock[out] < TARGET[out] && Object.entries(needs).every(([t, n]) => stock[t] >= n)) {
      for (const [t, n] of Object.entries(needs)) stock[t] -= n;
      stock[out] += 1;
      const last = jobs[jobs.length - 1];
      if (last && last.op === "craft" && last.token === out) last.qty += 1;
      else jobs.push({ op: "craft", token: out, qty: 1 });
    }
  }
  // ship what is piling up, a few at a time (the boat to the mainland is small;
  // it stays in harbour in a storm, and the contract would refuse it anyway)
  if (market.storm?.active) return jobs;
  for (const token of RAW) {
    const surplus = stock[token] - Math.ceil(TARGET[token] * 1.5);
    // ... but never at a loss: goods she overpaid for stay on the shelf (and push
    // her bids down) until cheaper stock brings her average cost under the export price
    const pays = (exportPrice[token] ?? 0) >= (market.avgCost[token] ?? 0);
    if (surplus > 0 && (exportPrice[token] ?? 0) > 0 && pays) jobs.push({ op: "export", token, qty: Math.min(surplus + Math.floor(TARGET[token] / 2), 6) });
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// The notice board: what Maren buys off players' notices
// ---------------------------------------------------------------------------

/// Players get first pick: Maren leaves a fresh notice alone for this long.
export const BOARD_GRACE_MS = { raw: 15_000, ware: 180_000 };
/// She buys a used tool for at most this fraction of what it is worth on a quiet day.
export const USED_TOOL_DISCOUNT = 0.55;

/// The most she pays for a used tool while she holds `stock` of it: nothing
/// unless she is short, then a discount on its everyday value (never on her
/// scarcity price, or players could buy her last one and sell it straight back).
export function usedToolPrice(market, token, stock = market.stock[token]) {
  if (stock >= TARGET[token]) return 0;
  return Math.min(VALUE[token], unitAsk(market, token, stock)) * USED_TOOL_DISCOUNT;
}

/// Which notices Maren buys, and how many from each.
///   Raw goods: each unit she would bid at least the asking price for (her bid
///     drops with every unit she takes, so a big lot may be bought in part).
///   Tools: only while she is short of them, and only at a good discount, so
///     buying from her and selling back to her cannot turn a profit.
/// `listings`: [{ id, seller, token, qty, unit (coins), listedMs, expiresMs }].
/// `market` may carry `boughtInWindow` and `windowLimit` (coins) for her spending cap.
/// Returns [{ id, seller, token, qty, total }], cheapest notices first.
export function boardPicks(market, listings, now, self = null) {
  const stock = { ...market.stock };
  let treasury = market.treasury;
  let spent = market.boughtInWindow ?? 0;
  const limit = market.windowLimit ?? Infinity;
  const picks = [];
  const open = listings.filter((l) => now <= l.expiresMs && l.seller !== self).sort((a, b) => a.unit - b.unit || a.listedMs - b.listedMs);
  for (const l of open) {
    const raw = RAW.includes(l.token);
    if (!raw && !WARES.includes(l.token)) continue;
    if (now - l.listedMs < (raw ? BOARD_GRACE_MS.raw : BOARD_GRACE_MS.ware)) continue;
    if (l.unit > (market.ceiling[l.token] ?? Infinity)) continue; // the contract would refuse it
    const books = () => ({ ...market, stock, treasury });
    let qty = 0;
    for (; qty < l.qty; qty++) {
      const s = stock[l.token] + qty;
      const fair = raw ? unitBid(books(), l.token, s) : usedToolPrice(books(), l.token, s);
      if (l.unit > fair || (qty + 1) * l.unit > treasury || spent + (qty + 1) * l.unit > limit) break;
    }
    if (qty === 0) continue;
    const total = qty * l.unit;
    picks.push({ id: l.id, seller: l.seller, token: l.token, qty, total });
    stock[l.token] += qty;
    treasury -= total;
    spent += total;
  }
  return picks;
}

// ---------------------------------------------------------------------------
// Haggling
// ---------------------------------------------------------------------------

export const MOODS = ["sour", "wary", "even", "warm", "delighted"]; // mood -2..2

/// Start bargaining over a lot. `rng` is injectable for tests.
export function openHaggle(market, { side, token, qty, trades = 0, mood = 0 }, rng = Math.random) {
  const list = listPrice(market, side, token, qty);
  // How far she will really go, hidden from the player.
  let give = 0.12 + rng() * 0.08; // 12-20 %
  if (qty >= 5) give += 0.03; // bulk
  if (trades >= 5) give += 0.02; // a regular
  if (trades >= 15) give += 0.02;
  give += 0.01 * mood;
  let limit;
  if (side === "sell") {
    const hardFloor = Math.max((market.floor[token] ?? 0) * qty, (market.avgCost[token] ?? 0) * 1.08 * qty);
    limit = Math.max(Math.ceil(hardFloor), Math.round(list * (1 - give)));
    limit = Math.min(limit, list);
  } else {
    const hardCeil = Math.min((market.ceiling[token] ?? Infinity) * qty, market.treasury);
    limit = Math.min(Math.floor(hardCeil), Math.round(list * (1 + give)));
    limit = Math.max(limit, Math.min(list, Math.floor(hardCeil)));
  }
  return {
    side,
    token,
    qty,
    list: side === "buy" ? Math.min(list, limit) : list,
    counter: side === "buy" ? Math.min(list, limit) : list, // her current price
    limit, // her true limit
    round: 0,
    patience: 4 + (mood > 0 ? 1 : 0),
    mood,
    bluffUsed: false,
    charmUsed: false,
    final: false,
    over: false,
  };
}

/// One move by the player. Returns { kind, price?, session }.
/// kinds: "deal" (agreed at price), "counter", "final" (take it or leave it),
/// "insulted", "walked" (she lets you go), "calledback", "charmed", "gaveup".
export function haggle(session, move) {
  const s = { ...session };
  const sell = s.side === "sell";
  // "better for the player" means lower when she sells, higher when she buys
  const playerGainsFrom = (price, than) => (sell ? price < than : price > than);
  const acceptable = (offer) => (sell ? offer >= s.limit : offer <= s.limit);

  if (s.over) return { kind: "gaveup", session: s };

  if (move.type === "accept") {
    s.over = true;
    return { kind: "deal", price: s.counter, session: s };
  }

  if (move.type === "charm") {
    if (s.charmUsed) return { kind: "counter", price: s.counter, session: s, stale: true };
    s.charmUsed = true;
    s.mood = clamp(s.mood + 1, -2, 2);
    // a kind word is worth a little
    const step = Math.max(1, Math.round(Math.abs(s.counter - s.limit) * 0.2));
    s.counter = sell ? Math.max(s.limit, s.counter - step) : Math.min(s.limit, s.counter + step);
    return { kind: "charmed", price: s.counter, session: s };
  }

  if (move.type === "walk") {
    const room = Math.abs(s.counter - s.limit);
    if (!s.bluffUsed && s.round >= 1 && s.mood >= -1 && room >= Math.max(1, s.list * 0.03)) {
      s.bluffUsed = true;
      s.final = true;
      const step = Math.round(room * 0.6);
      s.counter = sell ? s.counter - step : s.counter + step;
      return { kind: "calledback", price: s.counter, session: s };
    }
    s.over = true;
    return { kind: "walked", session: s };
  }

  if (move.type === "offer") {
    const offer = Math.round(move.price);
    if (!Number.isFinite(offer) || offer <= 0) return { kind: "counter", price: s.counter, session: s, stale: true };
    s.round += 1;
    // offered her price or better for her: done, at her price
    if (!playerGainsFrom(offer, s.counter)) {
      s.over = true;
      return { kind: "deal", price: s.counter, session: s };
    }
    if (acceptable(offer)) {
      // first reasonable offer: meet in the middle instead of folding at once
      const mid = Math.round((offer + s.counter) / 2);
      if (s.round === 1 && !s.final && mid !== offer && Math.abs(s.counter - offer) > Math.max(2, s.list * 0.06)) {
        s.counter = mid;
        return { kind: "counter", price: s.counter, session: s, close: true };
      }
      s.over = true;
      return { kind: "deal", price: offer, session: s };
    }
    // below her limit
    if (s.final) {
      s.over = true;
      s.mood = clamp(s.mood - 1, -2, 2);
      return { kind: "gaveup", session: s };
    }
    const insulting = sell ? offer < s.list * 0.5 : offer > s.list * 1.7;
    if (insulting) {
      s.mood = clamp(s.mood - 1, -2, 2);
      s.patience -= 2;
      if (s.patience <= 0) {
        s.over = true;
        return { kind: "gaveup", session: s };
      }
      return { kind: "insulted", price: s.counter, session: s };
    }
    s.patience -= 1;
    const k = clamp(0.35 + 0.08 * s.mood, 0.15, 0.6);
    const step = Math.max(1, Math.round(Math.abs(s.counter - s.limit) * k));
    const next = sell ? Math.max(s.limit, s.counter - step) : Math.min(s.limit, s.counter + step);
    if (s.patience <= 0 || next === s.counter) {
      s.counter = s.limit;
      s.final = true;
      return { kind: "final", price: s.counter, session: s };
    }
    s.counter = next;
    return { kind: "counter", price: s.counter, session: s };
  }

  return { kind: "counter", price: s.counter, session: s, stale: true };
}

/// A one-line reason to show with her answer while you haggle. It says why she
/// moved (or didn't), never how far she would still go. `kind` is the result's
/// kind from `haggle` (or "open"); `trades` is how many deals you have made.
export function haggleWhy(kind, session, { trades = 0, who = "maren" } = {}) {
  const [she, her] = who === "silas" ? ["he", "his"] : ["she", "her"];
  const s = session ?? {};
  const moodWord = s.mood > 0 ? `${she}'s in a good mood, so ${she} gives a little more ground` : s.mood < 0 ? `${she} hasn't forgotten how you treated ${who === "silas" ? "him" : "her"}, so ${she} gives less ground` : "";
  const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : "");
  switch (kind) {
    case "open": {
      const parts = [];
      if (trades >= 15) parts.push(`you're one of ${her} best customers`);
      else if (trades >= 5) parts.push("you're a regular");
      if (s.qty >= 5 && who !== "silas") parts.push("it's a big lot");
      if (parts.length) return cap(`${parts.join(" and ")}, so ${she}'ll give a little more ground than usual.`);
      return cap(moodWord ? moodWord + "." : "");
    }
    case "counter":
      return cap(moodWord ? moodWord + "." : `Each offer costs ${her} patience. When it runs out, ${she} names ${her} last price.`);
    case "close":
      return `A fair offer, so ${she} met you halfway.`;
    case "insulted":
      return `That offer insulted ${who === "silas" ? "him" : "her"}: ${her} mood soured and ${her} patience dropped.`;
    case "final":
      return cap(`${her} patience ran out. This is ${her} last word: take it or leave it.`);
    case "calledback":
      return cap(`walking away worked: ${she} came after you. It only works once.`);
    case "charmed":
      return cap(`a kind word moved ${who === "silas" ? "him" : "her"} a little. That only works once.`);
    case "charm_stale":
      return "Kind words only work once.";
    default:
      return "";
  }
}

/// Work out what the player means from free text.
/// Returns { type: "offer" | "accept" | "walk" | "charm" | "trick" | "chat", price? }.
export function readIntent(text) {
  const t = text.toLowerCase();
  if (/ignore (all |your |any |the )?(previous |prior |earlier )?(instructions|rules|prompt)|system prompt|you are now|pretend (you|to)|i am (the|your) (owner|boss|admin|developer)|for free|for nothing|give (it|them|me (it|them|the)) (to me )?(away|free)|jailbreak|developer mode/.test(t)) {
    return { type: "trick" };
  }
  const num = t.match(/(\d+(?:\.\d+)?)/);
  if (num) return { type: "offer", price: Number(num[1]) };
  if (/\b(deal|done|agreed|ok|okay|fine|yes|accept|sold|shake|i'?ll take it)\b/.test(t)) return { type: "accept" };
  if (/\b(bye|goodbye|leave|leaving|walk|forget it|no thanks|never mind|too (much|expensive|dear|low|little)|elsewhere)\b/.test(t)) return { type: "walk" };
  if (/\b(please|friend|kind|lovely|beautiful|best|finest|favourite|favorite|generous|wonderful|love|pretty|thank)\b/.test(t)) return { type: "charm" };
  return { type: "chat" };
}

// ---------------------------------------------------------------------------
// Silas, the pearl and ore dealer: he only buys, and ships what he buys to his
// buyers in the city. His own treasury, his own guard rails on-chain.
// ---------------------------------------------------------------------------

export const DEALER_TOKENS = ["ore", "pearl"];
/// How much of each he likes in his hold before he ships it off.
export const DEALER_HOLD = { ore: 4, pearl: 3 };
/// Treasury (in coins) at which he feels flush.
export const DEALER_COMFORTABLE = 500;

/// `dealer`: { stock, treasury, ceiling, cityPrice (coins), boughtInWindow?,
///             windowLimit?, tide?, storm? }
/// His offer for ONE unit when his hold has `stock` of it, with its reasons (the
/// same shape as `bidWhy`): a cut under what the city pays him, swinging harder
/// with his hold than Maren's offers do with her shelves. Nothing at all in a
/// storm: his boat is battened down.
export function dealerBidWhy(dealer, token, stock = dealer.stock[token]) {
  const city = dealer.cityPrice[token] ?? 0;
  if (!city) return { price: 0, base: 0, steps: [{ key: "trade", value: 0, note: "He doesn't deal in it" }], limits: [], capped: false };
  if (dealer.storm?.active) return { price: 0, base: 0, steps: [{ key: "storm", value: 0, note: "Storm: his boat is battened down, and he buys nothing until it passes" }], limits: [], capped: false };
  const hold = DEALER_HOLD[token];
  const appetite = clamp(1.05 - (0.5 * stock) / hold, 0.3, 1.05);
  const cash = clamp(dealer.treasury / DEALER_COMFORTABLE, 0.3, 1);
  const tide = tideBidFactor(token, dealer.tide);
  const steps = [
    { key: "worth", value: city, note: `The city pays him ${city}` },
    { key: "cut", factor: 0.78, note: "He offers 78% of that, to pay for the trip" },
    { key: "hold", factor: appetite, note: stock >= hold ? `His hold is full (${stock} of ${hold}) until he ships` : stock === 0 ? `His hold is empty (room for ${hold}), so he's keen` : `His hold has ${stock} of ${hold}` },
    { key: "purse", factor: cash, note: cash < 1 ? `His purse is down to ${Math.floor(dealer.treasury)}, so he pays less` : "His purse is healthy" },
  ];
  const tNote = tideNote(token, dealer.tide, tide);
  if (tNote) steps.push({ key: "tide", factor: tide, note: tNote });
  const base = city * 0.78 * appetite * cash * tide;
  const ceiling = dealer.ceiling[token] ?? Infinity;
  const price = Math.min(base, city * 0.95, ceiling);
  const limits = [
    { key: "city", value: city * 0.95, binds: price < base && price === city * 0.95, note: `Never more than 95% of the city's price, or the trip doesn't pay` },
    { key: "ceiling", value: ceiling, binds: price < base && price === ceiling && price !== city * 0.95, note: `The ledger won't let him pay more than ${n1(ceiling)}` },
  ];
  return { price, base, steps, limits, capped: price !== base };
}

/// His offer for ONE unit when his hold has `stock` of it.
export function dealerBid(dealer, token, stock = dealer.stock[token]) {
  return dealerBidWhy(dealer, token, stock).price;
}

/// His price board: what he pays for one of each, now.
export function dealerBoard(dealer) {
  return DEALER_TOKENS.map((token) => {
    const why = dealerBidWhy(dealer, token);
    return { token, stock: dealer.stock[token], price: Math.round(why.price), why };
  });
}

/// Start bargaining with Silas over a lot he would buy. He gives less ground
/// than Maren (6-12 %) and loses patience sooner. Same session shape, so
/// `haggle` plays it out.
export function openDealerHaggle(dealer, { token, qty, trades = 0, mood = 0 }, rng = Math.random) {
  let list = 0;
  for (let i = 0; i < qty; i++) list += dealerBid(dealer, token, dealer.stock[token] + i);
  list = Math.round(list);
  let give = 0.06 + rng() * 0.06;
  if (trades >= 5) give += 0.01;
  give += 0.01 * mood;
  const budget = (dealer.windowLimit ?? Infinity) - (dealer.boughtInWindow ?? 0);
  const hardCeil = Math.floor(Math.min((dealer.ceiling[token] ?? Infinity) * qty, dealer.treasury, budget));
  let limit = Math.min(hardCeil, Math.round(list * (1 + give)));
  limit = Math.max(limit, Math.min(list, hardCeil));
  const counter = Math.min(list, limit);
  return { side: "buy", token, qty, list: counter, counter, limit, round: 0, patience: 3 + (mood > 0 ? 1 : 0), mood, bluffUsed: false, charmUsed: false, final: false, over: false };
}

/// What he should ship to the city now: a full hold of each, and at high tide
/// (when his boat sails anyway) whatever he has, if the mainland can pay and
/// the sea lets him sail. Goods promised on the board stay. Returns [{ token, qty, pay }].
export function shipPlan(dealer, mainland, promised = {}) {
  if (dealer.storm?.active) return [];
  const jobs = [];
  let fund = mainland;
  for (const token of DEALER_TOKENS) {
    const qty = dealer.stock[token] - (promised[token] ?? 0);
    const pay = qty * (dealer.cityPrice[token] ?? 0);
    const sailing = qty >= DEALER_HOLD[token] || (qty > 0 && dealer.tide?.phase === "high");
    if (sailing && pay > 0 && pay <= fund) {
      jobs.push({ token, qty, pay });
      fund -= pay;
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Maren and Silas trade with each other, in the open, on the notice board
// ---------------------------------------------------------------------------

/// A merchant's notice nobody takes within this long comes down again, so the
/// promised goods can still be exported, shipped or sold.
export const MERCHANT_NOTICE_MS = 10 * 60_000;

/// What a merchant has promised on the board, per token.
export function promisedBy(listings, seller, now) {
  const out = {};
  for (const l of listings) if (l.seller === seller && now <= l.expiresMs) out[l.token] = (out[l.token] ?? 0) + l.qty;
  return out;
}

/// A merchant's own notices that have waited too long.
export function staleNotices(listings, seller, now) {
  return listings.filter((l) => l.seller === seller && now - l.listedMs > MERCHANT_NOTICE_MS);
}

/// Surplus ore and pearls Maren pins on the board because Silas pays more than
/// the mainland would (and more than they cost her). Priced at what he would
/// still pay for the last unit, so he takes the lot. Returns [{ token, qty, unit }].
export function marenNotices(market, promised = {}) {
  const d = market.dealer;
  if (!d || market.storm?.active) return []; // in a storm he buys nothing
  const out = [];
  for (const token of DEALER_TOKENS) {
    if (promised[token]) continue; // one notice per good at a time
    const surplus = market.stock[token] - Math.ceil(TARGET[token] * 1.5);
    const exportAt = market.exportPrice?.[token] ?? 0;
    const atLeast = Math.max(exportAt + 1, market.floor[token] ?? 0, market.avgCost[token] ?? 0);
    for (let qty = Math.min(surplus, 4); qty > 0; qty--) {
      const unit = Math.floor(dealerBid(d, token, d.stock[token] + qty - 1));
      if (unit >= atLeast) {
        const why = `Maren has more ${token === "ore" ? "ore" : "pearls"} than she needs (${market.stock[token]}; she likes ${TARGET[token]}). Silas would pay ${unit} each; the mainland pays only ${n1(exportAt)}.`;
        out.push({ token, qty, unit, why });
        break;
      }
    }
  }
  return out;
}

/// Pearls (or ore) Silas pins for Maren when she would pay more than the city
/// does, never under what they cost him. Returns [{ token, qty, unit }].
export function silasNotices(market, promised = {}) {
  const d = market.dealer;
  if (!d) return [];
  const out = [];
  for (const token of DEALER_TOKENS) {
    const free = d.stock[token] - (promised[token] ?? 0);
    if (promised[token] || free <= 0) continue;
    const unit = Math.floor(unitBid(market, token));
    if (unit <= d.cityPrice[token] || unit < Math.ceil(d.avgCost?.[token] ?? 0)) continue;
    let qty = 0; // as many as she would still pay that much for
    while (qty < free && unitBid(market, token, market.stock[token] + qty) >= unit) qty++;
    const short = neededFor(market, token);
    const why = `Maren would pay ${unit} each${short ? `, because she needs them for a ${short === "beacon" ? "beacon lens" : short}` : ""}. The city pays Silas only ${n1(d.cityPrice[token])}.`;
    if (qty > 0) out.push({ token, qty, unit, why });
  }
  return out;
}

/// Which notices Silas buys off the board: anyone's ore and pearls (not his
/// own) priced at or under his offer, after players have had first pick,
/// within his ceiling, purse and spending cap. Returns [{ id, seller, token, qty, total }].
export function dealerPicks(dealer, listings, now, self = null) {
  if (dealer.storm?.active) return [];
  const stock = { ...dealer.stock };
  let treasury = dealer.treasury;
  let spent = dealer.boughtInWindow ?? 0;
  const limit = dealer.windowLimit ?? Infinity;
  const picks = [];
  const open = listings
    .filter((l) => l.seller !== self && DEALER_TOKENS.includes(l.token) && now <= l.expiresMs && now - l.listedMs >= BOARD_GRACE_MS.raw)
    .sort((a, b) => a.unit - b.unit || a.listedMs - b.listedMs);
  for (const l of open) {
    if (l.unit > (dealer.ceiling[l.token] ?? 0)) continue; // the contract would refuse it
    let qty = 0;
    for (; qty < l.qty; qty++) {
      const fair = dealerBid({ ...dealer, treasury }, l.token, stock[l.token] + qty);
      if (l.unit > fair || (qty + 1) * l.unit > treasury || spent + (qty + 1) * l.unit > limit) break;
    }
    if (qty === 0) continue;
    const total = qty * l.unit;
    picks.push({ id: l.id, seller: l.seller, token: l.token, qty, total });
    stock[l.token] += qty;
    treasury -= total;
    spent += total;
  }
  return picks;
}
