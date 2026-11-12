// Tidewater Market: the game itself. Walk around, forage, haggle with Maren.
//
// Every forage and every trade is a real transaction on NEAR testnet, signed
// in this browser with a guest key that never leaves it. The player just sees
// a short "Combing the shore..." while it lands.

import { Near, loadKey, generateKey, actions, TGAS, yoctoToCoins } from "./near-lite.js";
import { TOKENS, NAMES, BLURB, ICONS } from "./icons.js";
import { W, H, HOTSPOTS, walkable, drawWorld } from "./world.js";

const $ = (id) => document.getElementById(id);
const RESERVE = 10n ** 23n; // 0.1 NEAR kept back for network fees, not shown as coins
const SAVE = "tidewater.guest";
const SPEED = 200;
const idx = (token) => TOKENS.indexOf(token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the world drawing needs to know
const S = {
  player: { x: 770, y: 505, face: -1, moving: false, digging: false, tool: null, carrying: false },
  floats: [],
  near: null,
  busyText: "",
  shopOpen: false,
  hasBoat: false,
  atSea: 0,
  night: false,
  nightAmount: 0,
  market: null,
};

let cfg, near, key, me, rules;
let save = null; // { accountId, secret, contract, flags }
let pv = null; // the player as the contract sees them
let pvAt = 0;
let coins = 0;
let busy = false; // a transaction is in flight
let started = false;
let target = null; // where a click sent the player
let sea = null; // the rowing animation
const keys = new Set();
const txs = [];

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await res.json().catch(() => ({ error: "The server gave a strange answer" }));
  if (!res.ok) throw new Error(j.error || "Something went wrong");
  return j;
}

// ---------- sound (tiny synth blips, no files) ----------
let audio = null;
function blip(freqs, dur = 0.09, type = "triangle", vol = 0.07) {
  try {
    audio ??= new AudioContext();
    freqs.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.frequency.value = f;
      const t0 = audio.currentTime + i * dur * 0.8;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 1.6);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + dur * 1.7);
    });
  } catch {
    /* no sound, no problem */
  }
}
const sfx = {
  found: () => blip([520, 660]),
  coin: () => blip([880, 1175, 1568], 0.07, "square", 0.04),
  bad: () => blip([200, 150], 0.12, "sawtooth", 0.04),
  talk: () => blip([330], 0.05, "sine", 0.04),
  win: () => blip([523, 659, 784, 1047, 1319], 0.18, "triangle", 0.08),
};

// ---------- toasts and floating text ----------
function toast(text, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 3500);
  if (bad) sfx.bad();
}
function float(text, icon, opts = {}) {
  S.floats.push({ text, icon, x: opts.x ?? S.player.x, y: opts.y ?? S.player.y - 70, life: 1.9, total: 1.9, bad: opts.bad, wait: opts.wait ?? 0 });
}

// ---------- other players (everything here comes from the contract's logs) ----------
/// A short name for an account: guests are "Guest 7f1f", anyone else keeps their name.
const mine = (account) => account === (me ?? save?.accountId); // (on the title screen, `me` is not set yet)
function who(account) {
  if (mine(account)) return "You";
  const g = account.match(/^g([0-9a-f]{4})[0-9a-f]*\./);
  return g ? `Guest ${g[1]}` : account.split(".")[0];
}
const MANY = { kelp: "kelp", driftwood: "driftwood", ore: "ore", pearl: "pearls", rope: "rope", pickaxe: "pickaxes", boat: "boats", beacon: "beacon lenses" };
const lot = (token, n) => (n === 1 ? (["kelp", "driftwood", "ore", "rope"].includes(token) ? "1 " : "a ") + NAMES[token].toLowerCase() : `${n} ${MANY[token]}`);
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function eventText(e) {
  const name = who(e.player);
  if (e.kind === "trade") return `${name} ${e.did} ${lot(e.token, e.qty)} ${e.did === "sold" ? "to" : "from"} Maren for ${e.coins} coins`;
  if (e.kind === "refused") {
    // a price outside her floors and ceilings only comes from someone trying to trick her
    if (/floor|ceiling/.test(e.reason)) return `${name} tried to talk Maren into a silly deal. The ledger refused it.`;
    return `The ledger stopped a deal with ${name}: ${e.reason.replace(/_/g, " ")}`;
  }
  return `${name} relit the lighthouse!`;
}

// The ticker under the purse: the latest few things other players did, one at a
// time. Something new jumps to the front. Your own deals are left out (you see those anyway).
const ticker = { items: [], i: 0, newest: 0, until: 0 };
function updateTicker() {
  const items = (S.market?.feed ?? []).filter((e) => e.player !== me).slice(0, 5);
  $("ticker").hidden = !started || items.length === 0;
  if (!items.length) return;
  const fresh = items[0].at > ticker.newest;
  const first = ticker.newest === 0;
  ticker.items = items;
  if (ticker.i >= items.length) ticker.i = 0;
  if (fresh) {
    ticker.newest = items[0].at;
    ticker.i = 0;
    showTick(!first);
  }
}
function showTick(isNew) {
  const e = ticker.items[ticker.i];
  $("ticker-icon").innerHTML = ICONS[e.kind === "keeper" ? "beacon" : e.token] ?? "";
  $("ticker-text").textContent = eventText(e);
  $("ticker-text").title = e.player;
  $("ticker-when").textContent = ago(e.at);
  const el = $("ticker");
  el.classList.remove("new", "turn");
  void el.offsetWidth;
  el.classList.add(isNew ? "new" : "turn");
  ticker.until = Date.now() + (isNew ? 10_000 : 6000);
}
setInterval(() => {
  if (!ticker.items.length || $("ticker").hidden) return;
  if (Date.now() >= ticker.until && ticker.items.length > 1) {
    ticker.i = (ticker.i + 1) % ticker.items.length;
    showTick(false);
  } else $("ticker-when").textContent = ago(ticker.items[ticker.i].at);
}, 1000);

const clock = (ms) => `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`;
const keeperRows = (list) =>
  list.map((x, i) => `<tr class="${mine(x.player) ? "me" : ""}"><td>${i + 1}.</td><td title="${x.player}">${who(x.player)}</td><td>${clock(x.took_ms)}</td><td>${x.trades} deals</td></tr>`).join("");

/// The title screen: how busy the market is and who has relit the lighthouse.
function renderBoard(m) {
  $("stats").textContent = `${m.players} ${m.players === 1 ? "person has" : "people have"} come ashore · ${m.deals} ${m.deals === 1 ? "deal" : "deals"} struck with Maren`;
  $("title-keepers").innerHTML = m.keepers.length ? keeperRows(m.keepers) : `<tr><td>Nobody has relit it yet. It could be you.</td></tr>`;
  $("board").hidden = false;
}

// A little line of how a price has moved lately (the server keeps the last few minutes).
function trend(token, upIsGood) {
  const h = S.market?.history;
  const line = h?.prices?.[token];
  if (!line || line.length < 2) return "";
  const vals = line.filter((v) => v != null);
  if (!vals.length) return "";
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = Math.max(1, hi * 0.3); // a small wobble should look like a wobble, not a cliff
  if (hi - lo < span) {
    const mid = (hi + lo) / 2;
    lo = mid - span / 2;
    hi = mid + span / 2;
  }
  const w = 56;
  const ht = 18;
  const x = (i) => ((i / (line.length - 1)) * (w - 4) + 2).toFixed(1);
  const y = (v) => (ht - 2 - ((v - lo) / (hi - lo)) * (ht - 4)).toFixed(1);
  let d = "";
  let pen = false;
  line.forEach((v, i) => {
    if (v == null) return (pen = false); // sold out: a gap in the line
    d += `${pen ? "L" : "M"}${x(i)} ${y(v)}`;
    pen = true;
  });
  // net change over the last two minutes
  const now = line[line.length - 1];
  const from = h.at.findIndex((t) => t >= h.at[h.at.length - 1] - 120_000);
  const then = line[from];
  let arrow = "";
  let mood = "flat";
  if (now != null && then != null && now !== then) {
    mood = now > then === upIsGood ? "good" : "bad";
    const delta = Math.abs(now - then);
    arrow = `<i class="${mood}" title="${then} coins two minutes ago">${now > then ? "▲" : "▼"}${delta >= 10 ? Math.round(delta) : +delta.toFixed(1)}</i>`;
  }
  const dot = now != null ? `<circle cx="${x(line.length - 1)}" cy="${y(now)}" r="2"/>` : "";
  return `<span class="trend ${mood}" title="Price over the last few minutes"><svg viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}"><path d="${d}"/>${dot}</svg>${arrow}</span>`;
}

// ---------- chain ----------
let lastTxAt = -1e9;
async function call(method, args = {}, deposit = 0n, label = method) {
  let res;
  try {
    res = await near.send(me, key, cfg.contract, [actions.functionCall(method, args, 15n * TGAS, deposit)]);
  } finally {
    lastTxAt = performance.now();
  }
  txs.unshift({ label, hash: res.txHash });
  txs.length = Math.min(txs.length, 12);
  renderLedger();
  return res;
}

function energyNow() {
  if (!pv) return { e: 0, frac: 0 };
  const max = pv.energy_max;
  if (pv.energy >= max) return { e: max, frac: 0 };
  const regen = rules.energy_regen_sec * 1000;
  let e = pv.energy;
  let rem = pv.next_energy_ms - (performance.now() - pvAt);
  while (rem <= 0 && e < max) {
    e++;
    rem += regen;
  }
  return { e, frac: e >= max ? 0 : 1 - rem / regen };
}

let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    try {
      const [p, bal, market] = await Promise.all([
        near.view(cfg.contract, "get_player", { account_id: me }),
        near.balance(me),
        api("/api/market?player=" + me).catch(() => S.market),
      ]);
      if (p) {
        const before = pv;
        pv = p;
        pvAt = performance.now();
        for (const t of TOKENS) if (before && p.items[idx(t)] > before.items[idx(t)]) bump(t);
      }
      // NEAR holds back a deposit for network fees while a transaction settles and
      // refunds most of it a moment later, so do not trust the balance right after one.
      const settling = performance.now() - lastTxAt < 2500;
      if (bal > 0n && !settling) coins = Math.max(0, Math.floor(yoctoToCoins(bal > RESERVE ? bal - RESERVE : 0n)));
      else setTimeout(refresh, settling ? 2600 : 1500); // (a brand-new account can also take a moment to show up)
      S.market = market;
      renderHud();
      updateTicker();
      if (S.shopOpen) renderShop();
    } catch (e) {
      console.warn("refresh:", e.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- HUD ----------
const SLOTS = ["kelp", "driftwood", "ore", "pearl", "pickaxe", "boat", "beacon"];
function buildHud() {
  $("coin-icon").innerHTML = ICONS.coin;
  $("energy-icon").innerHTML = ICONS.energy;
  $("pips").innerHTML = "<i></i>".repeat(rules.energy_max);
  $("pips").style.gridTemplateColumns = `repeat(${rules.energy_max}, 9px)`;
  $("inv").innerHTML = SLOTS.map((t) => `<div class="slot empty" id="slot-${t}" title="${NAMES[t]}">${ICONS[t]}<b>0</b></div>`).join("");
  for (const id of ["purse", "inv", "goal", "help", "ledger-btn"]) $(id).hidden = false;
}
function bump(token) {
  const el = $("slot-" + token);
  if (!el) return;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}
function renderHud() {
  if (!pv) return;
  $("coins").textContent = coins;
  for (const t of SLOTS) {
    const n = pv.items[idx(t)];
    const el = $("slot-" + t);
    el.classList.toggle("empty", n === 0);
    el.querySelector("b").textContent = n;
  }
  S.hasBoat = pv.items[idx("boat")] > 0;
  S.player.carrying = ["kelp", "driftwood", "ore", "pearl"].some((t) => pv.items[idx(t)] > 0);
  S.night = pv.lit_ms > 0;

  // remember what the player has ever owned, for the goal list
  const f = save.flags;
  let changed = false;
  for (const t of ["pickaxe", "boat", "beacon"]) {
    if (pv.items[idx(t)] > 0 && !f[t]) {
      f[t] = true;
      changed = true;
    }
  }
  if (changed) localStorage.setItem(SAVE, JSON.stringify(save));
  const steps = [
    ["Comb the shore, sell to Maren", pv.trades > 0],
    ["Buy a pickaxe, mine the cliffs", f.pickaxe],
    ["Buy a boat, find pearls on the reef", f.boat],
    ["Buy the beacon lens", f.beacon || pv.lit_ms > 0],
    ["Light the lighthouse", pv.lit_ms > 0],
  ];
  const now = steps.findIndex(([, done]) => !done);
  $("steps").innerHTML = steps.map(([text, done], i) => `<li class="${done ? "done" : i === now ? "now" : ""}">${text}</li>`).join("");
}
function renderEnergy() {
  if (!pv) return;
  const { e, frac } = energyNow();
  const pips = $("pips").children;
  for (let i = 0; i < pips.length; i++) {
    pips[i].className = i < e ? "on" : i === e ? "next" : "";
    if (i === e) pips[i].style.setProperty("--fill", Math.round(frac * 100) + "%");
  }
}

// ---------- foraging ----------
const BUSY_TEXT = { shore: "Combing the shore", cliffs: "Mining", reef: "Rowing out to the reef" };

async function forage(h) {
  if (busy) return;
  if (h.tool && pv.items[idx(h.tool)] === 0) {
    return toast(h.tool === "pickaxe" ? "The rock is too hard for bare hands. Maren sells pickaxes." : "The reef is too far to swim. You'd need a boat.", true);
  }
  if (energyNow().e < h.cost) return toast("You're worn out. Catch your breath for a moment.", true);
  busy = true;
  S.busyText = BUSY_TEXT[h.id];
  const p = S.player;
  if (h.id === "reef") sea = { phase: "out", t0: performance.now() };
  else {
    p.digging = true;
    p.tool = h.id === "cliffs" ? "pickaxe" : "rake";
    p.face = h.id === "shore" ? -1 : 1;
  }
  try {
    const { value: r } = await call("forage", { spot: h.id }, 0n, BUSY_TEXT[h.id]);
    if (sea) {
      sea = { phase: "back", t0: performance.now() };
      await sleep(700);
    }
    const at = h.id === "reef" ? { x: 250, y: 500 } : {};
    let n = 0;
    r.found.forEach((qty, i) => {
      if (qty > 0) float(`+${qty} ${NAMES[TOKENS[i]].toLowerCase()}`, TOKENS[i], { ...at, wait: n++ * 0.35 });
    });
    sfx.found();
    if (r.tool_broke) {
      float("Your pickaxe broke!", "pickaxe", { bad: true, wait: n * 0.35 });
      toast("Snap! Your pickaxe broke. Maren will sell you another.", true);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (sea && sea.phase === "out") sea = { phase: "back", t0: performance.now() }; // row home even if the trip failed
    p.digging = false;
    S.busyText = "";
    busy = false;
    refresh();
  }
}

async function lighthouse() {
  if (busy) return;
  if (pv.items[idx("beacon")] === 0) {
    return toast(pv.lit_ms > 0 ? "Your light is burning. The boats will find their way home." : "The lamp room is dark and empty. It needs a beacon lens. Maren could make one.");
  }
  busy = true;
  S.busyText = "Climbing the stairs";
  try {
    const { value: k } = await call("light_beacon", {}, 0n, "Lit the lighthouse");
    S.night = true;
    sfx.win();
    await refresh();
    await sleep(2600);
    const keepers = await near.view(cfg.contract, "get_keepers").catch(() => []);
    $("win-text").textContent = `You relit the lighthouse in ${clock(k.took_ms)}, with ${k.forages} trips out and ${k.trades} deals struck. Maren says she never doubted you.`;
    $("keepers").innerHTML = keeperRows(keepers.slice(0, 5));
    $("win").hidden = false;
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busyText = "";
    busy = false;
  }
}

function interact(id) {
  if (busy || !started) return;
  const h = HOTSPOTS.find((s) => s.id === id);
  if (id === "stall") openShop();
  else if (id === "lighthouse") lighthouse();
  else forage(h);
}

// ---------- Maren's stall ----------
let session = null;
let tab = "buy";
let talking = false;
const sellQty = {};
let typing = 0;

function sayBubble(text) {
  const el = $("bubble");
  const mine = ++typing;
  el.textContent = "";
  let i = 0;
  const tick = () => {
    if (mine !== typing) return;
    el.textContent = text.slice(0, (i += 2));
    if (i < text.length) setTimeout(tick, 16);
  };
  tick();
  sfx.talk();
}

function openShop() {
  S.shopOpen = true;
  target = null;
  $("shop").hidden = false;
  $("stamp").hidden = true;
  session = null;
  sayBubble(pv.trades >= 5 ? "Back again! My ledger likes you. What do you need?" : pv.trades > 0 ? "Tide's in and so am I. What'll it be?" : "A new face! I buy what the sea leaves behind, and I sell what you'll need to get more of it.");
  tab = SLOTS.slice(0, 4).some((t) => pv.items[idx(t)] > 0) ? "sell" : "buy";
  renderShop();
  refresh();
}
function closeShop() {
  S.shopOpen = false;
  $("shop").hidden = true;
  session = null;
}

let lastList = "";
function renderShop() {
  const m = S.market;
  if (!m) return;
  $("mood").textContent = m.mood;
  $("mood").className = "chip " + m.mood;
  $("her-purse").textContent = m.treasury + " coins";
  $("her-profit").textContent = m.profit + " coins";
  $("news").innerHTML = m.news.slice(0, 3).map((n) => `<li>${n.text}</li>`).join("");
  $("tab-buy").classList.toggle("on", tab === "buy");
  $("tab-sell").classList.toggle("on", tab === "sell");

  let html = "";
  if (tab === "buy") {
    for (const w of m.board.sells) {
      const mine = pv.items[idx(w.token)];
      let sub = BLURB[w.token];
      if (w.stock === 0) {
        const needs = Object.entries(m.recipes[w.token])
          .map(([t, n]) => `<span class="need ${m.stock[t] >= n ? "ok" : "short"}">${ICONS[t]}${Math.min(m.stock[t], n)}/${n}</span>`)
          .join("");
        sub = `Sold out. To make one she needs ${needs}`;
      } else sub = `${w.stock} on the shelf. ${sub}`;
      if (mine > 0) sub += ` <b>You have ${mine}.</b>`;
      html += `<div class="item">${ICONS[w.token]}<div><div class="name">${NAMES[w.token]}${trend(w.token, false)}</div><div class="sub">${sub}</div></div>
        <div class="buy">${w.price ? `<span class="p">${w.price}</span><button class="btn small" data-open="sell" data-token="${w.token}" data-qty="1">Haggle</button>` : ""}</div></div>`;
    }
  } else {
    for (const b of m.board.buys) {
      const have = pv.items[idx(b.token)];
      const qty = Math.max(1, Math.min(have, sellQty[b.token] ?? have));
      html += `<div class="item">${ICONS[b.token]}<div><div class="name">${NAMES[b.token]}${trend(b.token, true)}</div><div class="sub">You have ${have}. She holds ${b.stock} and pays about ${b.price} each.</div></div>
        <div class="buy">${
          have > 0
            ? `<span class="qty"><button data-qty-token="${b.token}" data-d="-1">−</button>${qty}<button data-qty-token="${b.token}" data-d="1">+</button></span><button class="btn small" data-open="buy" data-token="${b.token}" data-qty="${qty}">Sell</button>`
            : ""
        }</div></div>`;
    }
  }
  if (html !== lastList) {
    $("list").innerHTML = html;
    lastList = html;
  }
  renderDeal();
}

function renderDeal() {
  const live = session && !session.over;
  $("deal").hidden = !live;
  if (!live) return;
  const selling = session.side === "sell"; // Maren sells, the player buys
  $("deal-icon").innerHTML = ICONS[session.token];
  $("deal-what").textContent = `${session.qty} × ${NAMES[session.token]}`;
  $("deal-price").textContent = session.counter;
  $("take").textContent = selling ? `Pay ${session.counter}` : `Take ${session.counter}`;
  $("patience").textContent = session.final ? "her final offer" : "patience " + "●".repeat(session.patience) + "○".repeat(Math.max(0, 5 - session.patience));
  $("deal-hint").textContent = selling ? (session.counter > coins ? `You have ${coins} coins. Offer less, or sell her something first.` : "Offer less than she asks.") : "Ask for more than she offers.";
  for (const id of ["offer-go", "take", "walk", "offer-up", "offer-down"]) $(id).disabled = talking;
}

async function hag(body) {
  if (talking) return;
  talking = true;
  renderDeal();
  try {
    const r = await api("/api/haggle", { player: me, ...body });
    const fresh = body.action === "open";
    session = r.session;
    sayBubble(r.reply);
    $("mood").textContent = r.mood;
    $("mood").className = "chip " + r.mood;
    if (r.blocked) {
      $("stamp").hidden = false;
      $("stamp").innerHTML = `REFUSED BY THE LEDGER: ${r.blocked.reason.replace(/_/g, " ")}. <a target="_blank" rel="noopener" href="${cfg.explorer}/txns/${r.blocked.txHash}">See it on-chain</a>`;
      txs.unshift({ label: "Maren's quote was refused", hash: r.blocked.txHash });
      renderLedger();
    } else if (fresh) $("stamp").hidden = true;
    if (session && fresh) $("offer").value = Math.max(1, Math.round(session.counter * (session.side === "sell" ? 0.85 : 1.15)));
    talking = false;
    renderDeal();
    if (r.deal) await settle(r.deal);
  } catch (e) {
    toast(e.message, true);
  } finally {
    talking = false;
    renderDeal();
  }
}

async function settle(deal) {
  const buying = deal.side === "sell";
  if (buying && deal.coins > coins) return toast(`You only have ${coins} coins. The offer stands for two minutes.`, true);
  busy = true;
  S.busyText = "Shaking on it";
  const what = `${deal.qty} ${NAMES[deal.token].toLowerCase()}`;
  try {
    await call("accept_quote", { id: deal.quoteId }, buying ? BigInt(deal.totalYocto) : 0n, buying ? `Bought ${what} for ${deal.coins}` : `Sold ${what} for ${deal.coins}`);
    coins = Math.max(0, coins + (buying ? -deal.coins : deal.coins)); // shown at once; the chain confirms in a moment
    sfx.coin();
    toast(buying ? `Bought ${what} for ${deal.coins} coins.` : `Sold ${what} for ${deal.coins} coins.`);
    float(`${buying ? "−" : "+"}${deal.coins}`, "coin");
    if (buying) float(`+${deal.qty} ${NAMES[deal.token].toLowerCase()}`, deal.token, { wait: 0.35 });
    delete sellQty[deal.token];
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busyText = "";
    busy = false;
    await refresh();
  }
}

// ---------- the ledger panel (for the curious) ----------
function renderLedger() {
  if (!cfg || !me) return;
  $("l-me").textContent = me;
  for (const [id, acc] of [["l-contract", cfg.contract], ["l-merchant", cfg.merchantId]]) {
    $(id).textContent = acc;
    $(id).href = `${cfg.explorer}/address/${acc}`;
  }
  $("txs").innerHTML = txs.map((t) => `<li><span>${t.label}</span><a target="_blank" rel="noopener" href="${cfg.explorer}/txns/${t.hash}">${t.hash.slice(0, 8)}…</a></li>`).join("");
}

// ---------- input ----------
const canvas = $("c");
const ctx = canvas.getContext("2d");

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
}
addEventListener("resize", resize);

const typingInField = () => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);

addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("win").hidden) $("win").hidden = true;
    else if (!$("ledger").hidden) $("ledger").hidden = true;
    else if (S.shopOpen) closeShop();
    return;
  }
  if (typingInField() || !started) return;
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
    keys.add(k);
    e.preventDefault();
  }
  if ((k === "e" || k === " " || k === "enter") && !e.repeat) {
    e.preventDefault();
    if (S.shopOpen) return;
    if (S.near) interact(S.near);
  }
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());

canvas.addEventListener("pointerdown", (e) => {
  if (!started || busy) return;
  if (S.shopOpen) closeShop();
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) * W) / rect.width;
  const y = ((e.clientY - rect.top) * H) / rect.height;
  // clicking a place of interest walks there and uses it
  let hit = HOTSPOTS.find((h) => Math.hypot(h.x - x, h.y - y) < 46);
  if (!hit && x > 722 && x < 878 && y > 280 && y < 410) hit = HOTSPOTS.find((h) => h.id === "stall");
  if (!hit && x > 350 && x < 424 && y > 6 && y < 156) hit = HOTSPOTS.find((h) => h.id === "lighthouse");
  if (!hit && x < 236 && y > 400 && y < 620) hit = HOTSPOTS.find((h) => h.id === "reef");
  if (!hit && x > 940 && y < 250) hit = HOTSPOTS.find((h) => h.id === "cliffs");
  if (hit) target = { x: hit.x, y: hit.y, then: hit.id };
  else {
    // a click on water or rock means "as close as I can get": step back towards the player
    let tx = x;
    let ty = y;
    const d = Math.hypot(S.player.x - x, S.player.y - y) || 1;
    for (let i = 0; i < 80 && !walkable(tx, ty); i++) {
      tx += ((S.player.x - x) / d) * 8;
      ty += ((S.player.y - y) / d) * 8;
    }
    if (walkable(tx, ty)) target = { x: tx, y: ty };
  }
});

$("shop-close").onclick = closeShop;
$("tab-buy").onclick = () => {
  tab = "buy";
  renderShop();
};
$("tab-sell").onclick = () => {
  tab = "sell";
  renderShop();
};
$("list").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.qtyToken) {
    const t = b.dataset.qtyToken;
    const have = pv.items[idx(t)];
    sellQty[t] = Math.max(1, Math.min(have, (sellQty[t] ?? have) + Number(b.dataset.d)));
    renderShop();
  } else if (b.dataset.open) {
    hag({ action: "open", side: b.dataset.open, token: b.dataset.token, qty: Number(b.dataset.qty) });
  }
});
$("offer-go").onclick = () => hag({ action: "offer", price: Number($("offer").value) });
$("take").onclick = () => hag({ action: "accept" });
$("walk").onclick = () => hag({ action: "walk" });
$("offer-up").onclick = () => ($("offer").value = Number($("offer").value || 0) + 1);
$("offer-down").onclick = () => ($("offer").value = Math.max(1, Number($("offer").value || 0) - 1));
$("offer").addEventListener("keydown", (e) => e.key === "Enter" && $("offer-go").click());
const speak = () => {
  const text = $("say").value.trim();
  if (!text || talking) return;
  hag({ action: "say", text });
  $("say").value = "";
};
$("say").addEventListener("keydown", (e) => e.key === "Enter" && speak());
$("say-go").onclick = speak;
$("ledger-btn").onclick = async () => {
  $("ledger").hidden = !$("ledger").hidden;
  if (!$("ledger").hidden) {
    renderLedger();
    const mv = await near.view(cfg.contract, "get_market").catch(() => null);
    if (mv) $("l-blocked").textContent = mv.blocked_count;
  }
};
$("win-close").onclick = () => ($("win").hidden = true);
$("new-game").onclick = () => {
  const b = $("new-game");
  if (b.dataset.sure) {
    localStorage.removeItem(SAVE);
    location.reload();
  } else {
    b.dataset.sure = "1";
    b.textContent = "Click again to leave this guest behind for good";
  }
};

// ---------- the loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  const p = S.player;

  if (started && !busy && !S.shopOpen) {
    let dx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    let dy = (keys.has("s") || keys.has("arrowdown") ? 1 : 0) - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
    if (dx || dy) target = null;
    else if (target) {
      // the pier has one way on and off: go by its landward end first
      const onPier = (q) => q.x < 505 && q.y > 540 && q.y < 580;
      if (target.via === undefined) target.via = onPier(target) !== onPier(p) ? { x: 522, y: 558 } : null;
      if (target.via && Math.hypot(p.x - target.via.x, p.y - target.via.y) < 8) target.via = null;
      const stop = target.via ?? target;
      dx = stop.x - p.x;
      dy = stop.y - p.y;
      if (stop === target && Math.hypot(dx, dy) < 7) {
        const then = target.then;
        target = null;
        dx = dy = 0;
        if (then) interact(then);
      }
    }
    const len = Math.hypot(dx, dy);
    p.moving = len > 0;
    if (len > 0) {
      // Head for the goal; if the way is blocked (water, cliffs, the stall), try
      // steering a little to either side, so the player slides around the coast.
      const step = SPEED * dt;
      for (const deg of [0, 25, -25, 50, -50, 75, -75, 90, -90]) {
        const a = (deg * Math.PI) / 180;
        const vx = (dx / len) * Math.cos(a) - (dy / len) * Math.sin(a);
        const vy = (dx / len) * Math.sin(a) + (dy / len) * Math.cos(a);
        if (walkable(p.x + vx * step, p.y + vy * step)) {
          p.x += vx * step;
          p.y += vy * step;
          break;
        }
      }
      if (Math.abs(dx) > 0.5) p.face = dx > 0 ? 1 : -1;
      if (target) {
        // give up on a click the player is no longer getting closer to
        const stop = target.via ?? target;
        const d = Math.hypot(stop.x - p.x, stop.y - p.y);
        if (target.bestFor !== stop || d < target.best - 2) {
          target.best = d;
          target.bestFor = stop;
          target.bestAt = now;
        } else if (now - target.bestAt > 1200) target = null;
      }
    }
  } else p.moving = false;

  // which place of interest is close enough to use
  S.near = null;
  let best = Infinity;
  for (const h of HOTSPOTS) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d < h.r && d < best) {
      best = d;
      S.near = h.id;
    }
  }

  // rowing to the reef: out, wait for the catch, back
  if (sea) {
    const k = (now - sea.t0) / 900;
    if (sea.phase === "out") S.atSea = Math.min(0.5, k * 0.5) || 0.001;
    else {
      S.atSea = 0.5 + Math.min(0.5, k * 0.5);
      if (k >= 1) {
        sea = null;
        S.atSea = 0;
      }
    }
  }

  S.nightAmount += ((S.night ? 0.7 : 0) - S.nightAmount) * Math.min(1, dt * 0.9);
  for (const f of S.floats) {
    if (f.wait > 0) f.wait -= dt;
    else f.life -= dt;
  }
  S.floats = S.floats.filter((f) => f.life > 0);

  const scale = canvas.width / W;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawWorld(ctx, t, S);
  renderEnergy();
  requestAnimationFrame(frame);
}

// ---------- start ----------
async function boot() {
  resize();
  requestAnimationFrame(frame);
  $("portrait").innerHTML = `<svg viewBox="0 0 56 56" width="56" height="56"><circle cx="28" cy="28" r="28" fill="#cfe4e0"/><circle cx="28" cy="11" r="7" fill="#d8d8d2"/><path d="M8 56c0-13 9-19 20-19s20 6 20 19z" fill="#2f7f86"/><path d="M14 44l14 10 14-10-3-5H17z" fill="#e3b24f"/><circle cx="28" cy="26" r="13" fill="#e9bf9b"/><path d="M15 25a13 13 0 0 1 26 0c-5-6-21-6-26 0z" fill="#d8d8d2"/><circle cx="23.5" cy="27" r="1.6" fill="#3b2f2a"/><circle cx="32.5" cy="27" r="1.6" fill="#3b2f2a"/><path d="M23 32q5 4 10 0" fill="none" stroke="#8a4c3a" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  try {
    cfg = await api("/api/config");
    near = new Near(cfg.rpcUrls);
    save = JSON.parse(localStorage.getItem(SAVE) || "null");
    if (save && save.contract !== cfg.contract) save = null;
    if (save) {
      $("start").textContent = "Walk back into the village";
      $("start-note").textContent = "Welcome back. Your things are where you left them.";
    }
    api("/api/market")
      .then((m) => {
        S.market ??= m;
        renderBoard(m);
      })
      .catch(() => {}); // the board is a nicety; the game starts without it
  } catch (e) {
    $("start").disabled = true;
    $("start-note").textContent = "The game server is not answering. Start it with: node server/server.js";
  }
}

$("start").onclick = async () => {
  const btn = $("start");
  btn.disabled = true;
  const note = (text) => ($("start-note").textContent = text);
  try {
    if (!save) {
      note("Rowing you ashore…");
      const kp = await generateKey();
      const { accountId } = await api("/api/guest", { publicKey: kp.publicKey });
      save = { accountId, secret: kp.secret, contract: cfg.contract, flags: {} };
      localStorage.setItem(SAVE, JSON.stringify(save));
    }
    save.flags ??= {};
    me = save.accountId;
    key = await loadKey(save.secret);
    note("Finding your feet…");
    [rules, pv] = await Promise.all([near.view(cfg.contract, "get_rules"), near.view(cfg.contract, "get_player", { account_id: me })]);
    if (!pv) {
      for (let i = 0; ; i++) {
        try {
          await call("join", {}, 0n, "Arrived in Tidewater");
          break;
        } catch (e) {
          if (i >= 3) throw e;
          await sleep(1200);
        }
      }
    }
    buildHud();
    await refresh();
    S.nightAmount = S.night ? 0.7 : 0;
    $("title").hidden = true;
    started = true;
    updateTicker();
    if (pv.forages === 0) setTimeout(() => toast("Walk down to the tide pools on the shore and press E."), 900);
    setInterval(() => {
      if (!busy && !document.hidden) refresh();
    }, 7000);
  } catch (e) {
    btn.disabled = false;
    note("That didn't work: " + e.message);
  }
};

boot();
