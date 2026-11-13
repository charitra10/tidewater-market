// Maren's head for business. Pure functions and one small state machine: no
// network, no chain. Prices come from what is on her shelves, what she paid
// for it and how much coin she has, so the economy moves by itself.
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

/// Her asking price for ONE unit when `stock` of it are left on the shelf.
export function unitAsk(market, token, stock = market.stock[token]) {
  const target = TARGET[token];
  const scarcity = clamp(1 + (0.6 * (target - stock)) / target, 0.8, 1.6);
  const wantsCash = market.treasury < COMFORTABLE * 0.5 ? 0.92 : 1;
  const price = VALUE[token] * scarcity * wantsCash;
  // never below what it cost her plus a margin, never below the on-chain floor
  return Math.max(price, (market.avgCost[token] ?? 0) * 1.15, market.floor[token] ?? 0);
}

/// Does she need this raw good to make something she has run out of?
function neededForCrafting(market, token) {
  for (const [out, needs] of Object.entries(RECIPES)) {
    if (needs[token] && market.stock[out] < TARGET[out] && market.stock[token] < needs[token]) return true;
  }
  return false;
}

/// What she offers for ONE unit when she already holds `stock` of it.
export function unitBid(market, token, stock = market.stock[token]) {
  const target = TARGET[token];
  let need = clamp(1 + (0.5 * (target - stock)) / target, 0.55, 1.5);
  if (neededForCrafting({ ...market, stock: { ...market.stock, [token]: stock } }, token)) need *= 1.15;
  const cash = clamp(market.treasury / COMFORTABLE, 0.35, 1);
  // everyone brings kelp in at low tide, nobody at high tide; nobody brings pearls in a storm
  const weather = tideBidFactor(token, market.tide) * stormBidFactor(token, market.storm);
  const price = VALUE[token] * 0.62 * need * cash * weather;
  return Math.min(price, market.ceiling[token] ?? Infinity);
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
    sells: WARES.map((token) => ({ token, stock: market.stock[token], price: market.stock[token] > 0 ? listPrice(market, "sell", token, 1) : null })),
    buys: RAW.map((token) => ({ token, stock: market.stock[token], price: Math.max(1, Math.round(unitBid(market, token))) })),
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
/// His offer for ONE unit when his hold has `stock` of it: a cut under what the
/// city pays him, swinging harder with his hold than Maren's offers do with her
/// shelves. Nothing at all in a storm: his boat is battened down.
export function dealerBid(dealer, token, stock = dealer.stock[token]) {
  const city = dealer.cityPrice[token] ?? 0;
  if (!city || dealer.storm?.active) return 0;
  const appetite = clamp(1.05 - (0.5 * stock) / DEALER_HOLD[token], 0.3, 1.05);
  const cash = clamp(dealer.treasury / DEALER_COMFORTABLE, 0.3, 1);
  const price = city * 0.78 * appetite * cash * tideBidFactor(token, dealer.tide);
  return Math.min(price, city * 0.95, dealer.ceiling[token] ?? Infinity);
}

/// His price board: what he pays for one of each, now.
export function dealerBoard(dealer) {
  return DEALER_TOKENS.map((token) => ({ token, stock: dealer.stock[token], price: Math.round(dealerBid(dealer, token)) }));
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
        out.push({ token, qty, unit });
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
    if (qty > 0) out.push({ token, qty, unit });
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
