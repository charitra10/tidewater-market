// Tidewater Market: the game itself. Walk around, forage, haggle with Maren.
//
// Every forage and every trade is a real transaction on NEAR testnet, signed
// in this browser with a guest key that never leaves it. The player just sees
// a short "Combing the shore..." while it lands.

import { Near, loadKey, generateKey, actions, TGAS, yoctoToCoins, coinsToYocto } from "./near-lite.js";
import { TOKENS, NAMES, BLURB, ICONS } from "./icons.js";
import { W, H, HOTSPOTS, BOARD_BOX, walkable, drawWorld } from "./world.js";
import { tideAt, tideHeight, tideBidFactor, nextTide, tideName, TIDE_TEXT, TIDE_PERIOD_MS, stormAt, stormLevel, stormBidFactor, STORM_TEXT } from "./tide.js";

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
  boardOpen: false,
  board: [], // notices on the board (drawn as paper notes)
  hasBoat: false,
  atSea: 0,
  night: false,
  nightAmount: 0,
  market: null,
  tide: tideAt(Date.now()), // { phase, spring, endsMs, height }, see tide.js
  storm: { ...stormAt(Date.now()), level: 0 }, // { active, startMs, endsMs, level 0..1 }
};
let clockSkew = 0; // the shop's clock minus ours, so our tide agrees with Maren's
const nowMs = () => Date.now() + clockSkew;

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
function toast(text, bad = false, ms = 3500) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  if (ms !== 3500) el.style.animationDuration = `${(ms - 100) / 1000}s`;
  $("toasts").append(el);
  setTimeout(() => el.remove(), ms);
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
const noticeOf = (seller) => (mine(seller) ? "your notice" : `${who(seller)}'s notice`);
const MANY = { kelp: "kelp", driftwood: "driftwood", ore: "ore", pearl: "pearls", rope: "rope", pickaxe: "pickaxes", boat: "boats", beacon: "beacon lenses" };
const lot = (token, n) => (n === 1 ? (["kelp", "driftwood", "ore", "rope"].includes(token) ? "1 " : "a ") + NAMES[token].toLowerCase() : `${n} ${MANY[token]}`);
const yourLot = (token, n) => (n === 1 ? NAMES[token].toLowerCase() : `${n} ${MANY[token]}`);
const fmt = (c) => String(Math.round(c * 10) / 10); // coins, at most one decimal
const RAW = ["kelp", "driftwood", "ore", "pearl"];
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
  if (e.kind === "board_sale") {
    const buyer = e.maren ? "Maren" : name;
    if (mine(e.seller)) return `${buyer} bought your ${yourLot(e.token, e.qty)} off the notice board for ${e.coins} coins`;
    return `${buyer} bought ${lot(e.token, e.qty)} off ${noticeOf(e.seller)} for ${e.coins} coins`;
  }
  if (e.kind === "listed") return `${name} pinned ${lot(e.token, e.qty)} on the notice board at ${fmt(e.unit)} each`;
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

// ---------- the tide (it turns every 10 minutes; see tide.js) ----------
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const TIDE_NEXT = { low: "turns in", rising: "high in", high: "turns in", falling: "low in" };
const TIDE_NEWS = {
  low: "The tide is out. The rock pools are full of kelp, and the reef is shallow: pearls are easy.",
  springlow: "Spring tide! The lowest water in half an hour: kelp everywhere, and the reef half out of the sea.",
  high: "High tide. Driftwood is washing up the beach; the pools and the reef are under water.",
  springhigh: "Spring high tide! Driftwood all along the beach, and the reef deeper than ever.",
};
let lastTide = null;
let lastStorm = null;
let warnedFor = 0; // the storm we have already warned about
const STORM_NEWS = {
  warn: "Storm clouds on the horizon: a storm in 3 minutes. Row out to the reef now, or wait it out.",
  start: "A storm is blowing in! The reef is too rough to row to, but the shore is covered in wrack.",
  end: "The storm has blown over. The reef is calm again, and the mainland boat can sail.",
};

/// A little chart of the water: two minutes back, ten ahead.
function tideChart(now) {
  const w = 238, h = 38, from = now - 2 * 60_000, span = 12 * 60_000;
  const x = (ms) => ((ms - from) / span) * w;
  const y = (lvl) => h / 2 - lvl * 12.5;
  let line = "";
  for (let i = 0; i <= 96; i++) {
    const ms = from + (span * i) / 96;
    line += `${i ? "L" : "M"}${x(ms).toFixed(1)} ${y(tideHeight(ms)).toFixed(1)}`;
  }
  let labels = "";
  for (let c = Math.floor(from / TIDE_PERIOD_MS); c * TIDE_PERIOD_MS <= from + span; c++) {
    for (const [off, phase] of [[TIDE_PERIOD_MS / 8, "low"], [(TIDE_PERIOD_MS * 5) / 8, "high"]]) {
      const ms = c * TIDE_PERIOD_MS + off;
      const lx = x(ms);
      if (lx < 22 || lx > w - 22 || Math.abs(lx - x(now)) < 30) continue; // (the title names the tide you are in)
      const lvl = tideHeight(ms);
      const text = tideAt(ms).spring ? `spring ${phase}` : phase;
      labels += `<text x="${lx.toFixed(1)}" y="${(phase === "low" ? y(lvl) - 4 : y(lvl) + 11).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="#6b6357">${text}</text>`;
    }
  }
  let storms = "";
  for (let ms = from, seen = new Set(); ms < from + span; ms += 60_000) {
    const s = stormAt(ms);
    if (seen.has(s.startMs) || s.startMs > from + span) continue;
    seen.add(s.startMs);
    const x1 = Math.max(0, x(s.startMs));
    const x2 = Math.min(w, x(s.endsMs));
    if (x2 <= 0 || x1 >= w) continue;
    storms += `<rect x="${x1.toFixed(1)}" y="0" width="${(x2 - x1).toFixed(1)}" height="${h}" fill="rgba(52,58,74,.32)"/>`;
    if (x2 - x1 > 24) storms += `<text x="${((x1 + x2) / 2).toFixed(1)}" y="10" text-anchor="middle" font-size="8.5" font-weight="700" fill="#343a4a">storm</text>`;
  }
  const nx = x(now).toFixed(1);
  return `${storms}<path d="${line}L${w} ${h}L0 ${h}Z" fill="rgba(49,147,161,.3)"/><path d="${line}" fill="none" stroke="#2a8191" stroke-width="1.6"/>${labels}` +
    `<line x1="${nx}" x2="${nx}" y1="0" y2="${h}" stroke="#b8432f" stroke-width="1" stroke-dasharray="2 2"/><circle cx="${nx}" cy="${y(tideHeight(now)).toFixed(1)}" r="3.2" fill="#b8432f" stroke="#fff" stroke-width="1.2"/>`;
}

const WAVES = `<path d="M2 14c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" fill="none" stroke="#2a8191" stroke-width="2.2" stroke-linecap="round"/><path d="M2 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" fill="none" stroke="#7cc2c8" stroke-width="2.2" stroke-linecap="round"/>`;
const TIDE_ARROW = { rising: `<path d="M12 9V2m-3 3 3-3 3 3" fill="none" stroke="#b8432f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`, falling: `<path d="M12 2v7m-3-3 3 3 3-3" fill="none" stroke="#b8432f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` };

function renderTide() {
  const now = nowMs();
  const t = tideAt(now);
  S.tide = t;
  const card = $("tide");
  $("tide-icon").innerHTML = `<svg viewBox="0 0 24 24">${WAVES}${TIDE_ARROW[t.phase] ?? ""}</svg>`;
  $("tide-name").textContent = TIDE_TEXT[t.phase].name; // (a "spring" badge is added by CSS)
  card.classList.toggle("spring", t.spring && (t.phase === "low" || t.phase === "high"));
  $("tide-when").textContent = `${TIDE_NEXT[t.phase]} ${mmss(t.endsMs - now)}`;
  let what = TIDE_TEXT[t.phase].what;
  if (t.phase === "falling" && tideAt(nextTide(now, "low")).spring) what = "Spring low tide next: kelp everywhere, the reef half out of the sea";
  if (t.phase === "rising" && tideAt(nextTide(now, "high")).spring) what = "Spring high tide next: driftwood all along the beach";
  let price = TIDE_TEXT[t.phase].price + ".";
  const storm = stormAt(now);
  S.storm = { ...storm, level: S.storm.level };
  card.classList.toggle("storm", storm.active);
  if (storm.active) card.classList.remove("spring");
  if (storm.active) {
    $("tide-name").textContent = "Storm";
    $("tide-when").textContent = `passes in ${mmss(storm.endsMs - now)}`;
    what = STORM_TEXT.what;
    price = STORM_TEXT.price + ".";
  }
  const soon = !storm.active && storm.startMs - now < 10 * 60_000;
  $("tide-storm").hidden = !soon;
  if (soon) $("tide-storm").textContent = `Storm in ${mmss(storm.startMs - now)}: the reef will close`;
  $("tide-what").textContent = what;
  $("tide-price").textContent = price;
  $("tide-chart").innerHTML = tideChart(now);

  // the weather news
  if (started && lastStorm) {
    if (!lastStorm.active && storm.active) toast(STORM_NEWS.start, false, 7000);
    else if (lastStorm.active && !storm.active) toast(STORM_NEWS.end, false, 7000);
    else if (!storm.active && storm.startMs - now <= 180_000 && warnedFor !== storm.startMs) toast(STORM_NEWS.warn, false, 7000);
    if (lastStorm.active !== storm.active && S.shopOpen) renderShop();
  }
  if (!storm.active && storm.startMs - now <= 180_000) warnedFor = storm.startMs; // (no warning for a storm already upon you)
  lastStorm = storm;

  // say so when the water turns (but not for the tide you arrived on)
  if (lastTide && started && lastTide.phase !== t.phase && (t.phase === "low" || t.phase === "high") && !storm.active) {
    toast(TIDE_NEWS[(t.spring ? "spring" : "") + t.phase], false, 7000); // longer news, longer toast
    card.classList.remove("turn");
    void card.offsetWidth;
    card.classList.add("turn");
    if (S.shopOpen) renderShop(); // her offers just moved
  }
  lastTide = t;
}

/// For the stall: how the weather is moving her offer for a raw good.
function tideNote(token) {
  const s = stormBidFactor(token, S.storm);
  const f = s * tideBidFactor(token, S.tide);
  if (f === 1) return "";
  return ` <span class="tide-note ${f > 1 ? "up" : "down"}">${s !== 1 ? "Storm" : tideName(S.tide)}: she pays ${f > 1 ? "more" : "less"}</span>`;
}

const clock = (ms) => `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`;
const keeperRows = (list) =>
  list.map((x, i) => `<tr class="${mine(x.player) ? "me" : ""}"><td>${i + 1}.</td><td title="${x.player}">${who(x.player)}</td><td>${clock(x.took_ms)}</td><td>${x.trades} deals</td></tr>`).join("");

/// The title screen: how busy the market is and who has relit the lighthouse.
function renderBoard(m) {
  const up = (m.notices?.listings ?? []).filter((l) => l.expiresMs > Date.now()).length;
  $("stats").textContent =
    `${m.players} ${m.players === 1 ? "person has" : "people have"} come ashore · ${m.deals} ${m.deals === 1 ? "deal" : "deals"} struck with Maren` +
    (up ? ` · ${up} ${up === 1 ? "notice" : "notices"} on the board` : "");
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
function refresh(fresh = false) {
  refreshing ??= (async () => {
    try {
      const [p, bal, market] = await Promise.all([
        near.view(cfg.contract, "get_player", { account_id: me }),
        near.balance(me),
        api(`/api/market?player=${me}${fresh ? "&fresh=1" : ""}`).catch(() => S.market),
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
      if (market && market !== S.market && market.now) clockSkew = market.now - Date.now();
      S.market = market;
      S.board = (market?.notices?.listings ?? []).filter((l) => l.expiresMs > Date.now());
      tellSellerNews();
      renderHud();
      updateTicker();
      if (S.shopOpen) renderShop();
      if (S.boardOpen) renderNotices();
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
  for (const id of ["purse", "inv", "goal", "help", "ledger-btn", "tide"]) $(id).hidden = false;
  renderTide();
  setInterval(renderTide, 1000);
  $("tide").addEventListener("click", () => ($("tide-table").hidden = !$("tide-table").hidden));
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
  if (h.id === "reef" && stormAt(nowMs()).active) {
    return toast(`The sea is far too rough to row out. The storm passes in ${mmss(stormAt(nowMs()).endsMs - nowMs())}.`, true);
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
    const tools = ["boat", "pickaxe"].filter((t) => pv.items[idx(t)] > 0);
    $("win-pass").hidden = !tools.length;
    $("win-pass").textContent = `Your ${tools.map((t) => NAMES[t].toLowerCase()).join(" and ")} could start a newcomer off: pin ${tools.length > 1 ? "them" : "it"} on the notice board by the cottage.`;
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
  else if (id === "board") openNotices();
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
  const weather = S.storm.active
    ? "Get in out of the rain! What'll it be?"
    : S.tide.phase === "low"
      ? "Tide's out, so half the village is in the rock pools. What'll it be?"
      : S.tide.phase === "high"
        ? "Tide's in and so am I. What'll it be?"
        : "Tide or no tide, the stall's open. What'll it be?";
  sayBubble(pv.trades >= 5 ? "Back again! My ledger likes you. What do you need?" : pv.trades > 0 ? weather : "A new face! I buy what the sea leaves behind, and I sell what you'll need to get more of it.");
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
        const used = cheapestNotice(w.token);
        if (used) sub += ` <b>${who(used.seller)} has one on the notice board for ${fmt(used.unit)}.</b>`;
      } else sub = `${w.stock} on the shelf. ${sub}`;
      if (mine > 0) sub += ` <b>You have ${mine}.</b>`;
      html += `<div class="item">${ICONS[w.token]}<div><div class="name">${NAMES[w.token]}${trend(w.token, false)}</div><div class="sub">${sub}</div></div>
        <div class="buy">${w.price ? `<span class="p">${w.price}</span><button class="btn small" data-open="sell" data-token="${w.token}" data-qty="1">Haggle</button>` : ""}</div></div>`;
    }
  } else {
    for (const b of m.board.buys) {
      const have = pv.items[idx(b.token)];
      const qty = Math.max(1, Math.min(have, sellQty[b.token] ?? have));
      html += `<div class="item">${ICONS[b.token]}<div><div class="name">${NAMES[b.token]}${trend(b.token, true)}</div><div class="sub">You have ${have}. She holds ${b.stock} and pays about ${b.price} each.${tideNote(b.token)}</div></div>
        <div class="buy">${
          have > 0
            ? `<span class="qty"><button data-qty-token="${b.token}" data-d="-1">−</button>${qty}<button data-qty-token="${b.token}" data-d="1">+</button></span><button class="btn small" data-open="buy" data-token="${b.token}" data-qty="${qty}">Sell</button>`
            : ""
        }</div></div>`;
    }
    html += `<p class="sub board-hint">Want more than she pays? Pin your goods on the notice board by the cottage, at your own price.</p>`;
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

// ---------- the notice board: players sell to players ----------
let ntab = "buy";
const buyQty = {}; // notice id -> how many to buy
const pin = { token: null, qty: 1, price: 1 };
let lastNotices = "";

const marenAsk = (token) => S.market?.board?.sells.find((w) => w.token === token)?.price ?? null;
const marenBid = (token) => S.market?.history?.prices?.[token]?.at(-1) ?? S.market?.board?.buys.find((b) => b.token === token)?.price ?? 0;
const live = (l) => l.expiresMs > Date.now();
function cheapestNotice(token) {
  return S.board.filter((l) => l.token === token && !mine(l.seller)).sort((a, b) => a.unit - b.unit)[0];
}

function openNotices() {
  if (S.shopOpen) closeShop();
  S.boardOpen = true;
  document.body.classList.add("board-open"); // the panel covers the ticker's corner
  target = null;
  ntab = S.board.some((l) => !mine(l.seller)) ? "buy" : "pin";
  $("notices").hidden = false;
  lastNotices = "";
  renderNotices();
  refresh();
}
function closeNotices() {
  S.boardOpen = false;
  document.body.classList.remove("board-open");
  $("notices").hidden = true;
}

/// One notice in the "For sale" list.
function noticeRow(l) {
  const yours = mine(l.seller);
  const q = Math.max(1, Math.min(l.qty, buyQty[l.id] ?? l.qty));
  const total = l.unit * q;
  let compare;
  if (RAW.includes(l.token)) compare = `Maren pays about ${fmt(marenBid(l.token))}`;
  else {
    const ask = marenAsk(l.token);
    compare = ask === null ? `<span class="good">Maren is sold out</span>` : l.unit < ask ? `<span class="good">Maren asks ${ask}</span>` : `Maren asks ${ask}`;
  }
  const when = live(l) ? ago(l.listedMs) : "expired";
  let right;
  if (yours) right = `<button class="btn plain small" data-cancel="${l.id}">Take down</button>`;
  else if (!live(l)) right = `<span class="sub">expired</span>`;
  else {
    const stepper = l.qty > 1 ? `<span class="qty"><button data-bq="${l.id}" data-d="-1">−</button>${q}<button data-bq="${l.id}" data-d="1">+</button></span>` : "";
    right = `${stepper}<button class="btn small" data-buy="${l.id}" data-qty="${q}" ${total > coins ? "disabled title='Not enough coins'" : ""}>Buy for ${fmt(total)}</button>`;
  }
  return `<div class="item${yours ? " yours" : ""}">${ICONS[l.token]}<div><div class="name">${l.qty} × ${NAMES[l.token]} <span class="each">${fmt(l.unit)} each</span></div>
    <div class="sub">${yours ? "<b>Your notice</b>" : who(l.seller)} · ${when} · ${compare}</div></div><div class="buy">${right}</div></div>`;
}

function renderNotices() {
  const m = S.market;
  if (!m || !pv) return;
  const all = m.notices?.listings ?? [];
  const others = all.filter((l) => !mine(l.seller) && live(l)).sort((a, b) => b.listedMs - a.listedMs);
  const mineNow = all.filter((l) => mine(l.seller));
  const maxMine = rules.board?.max_per_seller ?? 3;
  $("n-coins").textContent = `you have ${coins} coins`;
  $("ntab-buy").textContent = `For sale${others.length ? ` (${others.length})` : ""}`;
  $("ntab-buy").classList.toggle("on", ntab === "buy");
  $("ntab-pin").classList.toggle("on", ntab === "pin");
  $("notice-list").hidden = ntab !== "buy";
  $("pin").hidden = ntab !== "pin";

  let html = "";
  if (ntab === "buy") {
    html = others.map(noticeRow).join("");
    if (!others.length) html = mineNow.length ? `<p class="empty">No one else is selling anything right now.</p>` : `<p class="empty">No one is selling anything right now. Pin the first notice: a spare tool, or goods at your own price.</p>`;
    if (mineNow.length) html += `<h4>Your notices</h4>` + mineNow.map(noticeRow).join("");
  } else {
    const bag = SLOTS.filter((t) => pv.items[idx(t)] > 0);
    if (pin.token && !bag.includes(pin.token)) pin.token = null;
    if (!pin.token && bag.length) pinDefaults(bag[0]); // start with a filled-in notice, not an empty form
    html = `<div class="field"><label>What</label><div class="chips">${
      bag.map((t) => `<button class="pick${pin.token === t ? " on" : ""}" data-pin="${t}" title="${NAMES[t]}">${ICONS[t]}<b>${pv.items[idx(t)]}</b></button>`).join("") ||
      `<span class="sub">Your bag is empty. Comb the shore first.</span>`
    }</div></div>`;
    if (pin.token) {
      const have = pv.items[idx(pin.token)];
      pin.qty = Math.max(1, Math.min(have, pin.qty));
      html += `<div class="field"><label>How many</label><span class="qty"><button data-pq="-1">−</button>${pin.qty}<button data-pq="1">+</button></span><span class="sub">of ${have}</span></div>
        <div class="field"><label>Price each</label><button class="step" data-pp="-1">−</button><input id="pin-price" type="number" min="1" inputmode="numeric" value="${pin.price}"><button class="step" data-pp="1">+</button><span class="sub">coins</span></div>
        <p class="sub" id="pin-sum">${pinSummary()}</p>`;
    }
    const full = mineNow.length >= maxMine;
    html += `<button class="btn" data-pin-go ${!pin.token || full || busy ? "disabled" : ""}>Pin it to the board</button>
      <p class="sub">${full ? `You have ${maxMine} notices up, the most allowed. Take one down to pin another.` : `Your goods wait on the board, not in your bag, until they sell. Notices last a day; take yours down any time.`}</p>`;
    if (mineNow.length) html += `<h4>Your notices (${mineNow.length} of ${maxMine})</h4>` + mineNow.map(noticeRow).join("");
  }
  // re-render only when something changed, and never under a price being typed
  const key = html + ntab;
  if (key !== lastNotices && document.activeElement?.id !== "pin-price") {
    (ntab === "buy" ? $("notice-list") : $("pin")).innerHTML = html;
    lastNotices = key;
  } else if ($("pin-sum") && pin.token) $("pin-sum").innerHTML = pinSummary();
  const sales = (m.notices?.sales ?? []).slice(0, 3);
  $("board-sales").innerHTML = sales.length
    ? sales.map((b) => `<li>${b.maren ? "Maren" : who(b.buyer)} bought ${lot(b.token_id, b.qty)} off ${noticeOf(b.seller)} for ${Math.round(yoctoToCoins(b.total))} coins.</li>`).join("")
    : `<li>No sales off the board yet.</li>`;
}

function pinSummary() {
  const bid = marenBid(pin.token);
  const ask = marenAsk(pin.token);
  let hint;
  if (RAW.includes(pin.token)) {
    hint =
      pin.price <= bid
        ? `That is no more than Maren pays (about ${fmt(bid)}), so she will probably buy it herself within a minute or two.`
        : `Maren pays about ${fmt(bid)} each. Another player may pay your price, or Maren will once her own price climbs to it.`;
  } else {
    hint = `${ask === null ? "Maren is sold out of these" : `Maren sells these for ${ask}`}. When she runs short she buys used ones too, but only cheaply.`;
  }
  return `${pin.qty} × ${NAMES[pin.token].toLowerCase()} at ${pin.price} each: <b>${pin.qty * pin.price} coins</b> if it all sells. ${hint}`;
}

function pinDefaults(token) {
  pin.token = token;
  pin.qty = pv.items[idx(token)];
  if (RAW.includes(token)) pin.price = Math.max(1, Math.round(marenBid(token) * 1.3));
  else pin.price = Math.max(1, Math.round((marenAsk(token) ?? S.market?.value?.[token] ?? 10) * 0.85));
  if (!RAW.includes(token)) pin.qty = 1;
}

async function boardTx(text, method, args, deposit, label) {
  if (busy) return null;
  busy = true;
  S.busyText = text;
  renderNotices();
  try {
    return await call(method, args, deposit, label);
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    S.busyText = "";
    busy = false;
    setTimeout(() => refresh(true), 700); // the server re-reads the board at most once a second
  }
}

async function pinNotice() {
  const { token, qty, price } = pin;
  if (!token || !(price >= 1)) return;
  const res = await boardTx("Pinning a notice", "list_item", { token_id: token, qty, unit_price: coinsToYocto(price).toString() }, 0n, `Pinned ${lot(token, qty)} at ${price} each`);
  if (!res) return;
  sfx.found();
  toast(`Pinned on the board: ${lot(token, qty)} at ${price} coins each.`);
  pv.items[idx(token)] -= qty; // shown at once; the chain confirms in a moment
  S.market.notices.listings.push(toNotice(res.value));
  pin.token = null;
  ntab = "buy";
  renderHud();
  renderNotices();
}
const toNotice = (l) => ({ id: l.id, seller: l.seller, token: l.token_id, qty: l.qty, unit: yoctoToCoins(l.unit_price), unitYocto: l.unit_price, listedMs: l.listed_ms, expiresMs: l.expires_ms });

async function buyNotice(id, qty) {
  const l = (S.market.notices?.listings ?? []).find((x) => x.id === id);
  if (!l) return;
  const total = l.unit * qty;
  if (total > coins) return toast(`That costs ${fmt(total)} coins and you have ${coins}.`, true);
  const what = lot(l.token, qty);
  const res = await boardTx("Counting out coins", "buy_listing", { id, qty }, BigInt(l.unitYocto) * BigInt(qty), `Bought ${what} off the board for ${fmt(total)}`);
  if (!res) return;
  coins = Math.max(0, Math.floor(coins - total));
  sfx.coin();
  toast(`Bought ${what} from ${who(l.seller)} for ${fmt(total)} coins. The coins went straight to them.`);
  float(`−${fmt(total)}`, "coin");
  float(`+${yourLot(l.token, qty)}`, l.token, { wait: 0.35 });
  l.qty -= qty;
  if (l.qty <= 0) S.market.notices.listings = S.market.notices.listings.filter((x) => x.id !== id);
  delete buyQty[id];
  renderHud();
  renderNotices();
}

async function takeDown(id) {
  const l = (S.market.notices?.listings ?? []).find((x) => x.id === id);
  if (!l) return;
  const res = await boardTx("Taking the notice down", "cancel_listing", { id }, 0n, `Took down ${lot(l.token, l.qty)}`);
  if (!res) return;
  toast(`Took the notice down. ${lot(l.token, l.qty)} back in your bag.`);
  S.market.notices.listings = S.market.notices.listings.filter((x) => x.id !== id);
  renderNotices();
}

/// When something of yours sells off the board while you are elsewhere, say so.
let salesSeen = null;
function tellSellerNews() {
  const sold = (S.market?.feed ?? []).filter((e) => e.kind === "board_sale" && mine(e.seller));
  const newest = Math.max(0, ...sold.map((e) => e.at));
  if (salesSeen === null) {
    salesSeen = newest; // old news
    return;
  }
  for (const e of sold.filter((e) => e.at > salesSeen).reverse()) {
    sfx.coin();
    toast(`${e.maren ? "Maren" : who(e.player)} bought your ${yourLot(e.token, e.qty)} off the notice board: +${e.coins} coins.`);
    float(`+${e.coins}`, "coin");
  }
  salesSeen = Math.max(salesSeen, newest);
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
    else if (S.boardOpen) closeNotices();
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
    if (S.shopOpen || S.boardOpen) return;
    if (S.near) interact(S.near);
  }
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());

canvas.addEventListener("pointerdown", (e) => {
  if (!started || busy) return;
  if (S.shopOpen) closeShop();
  if (S.boardOpen) closeNotices();
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) * W) / rect.width;
  const y = ((e.clientY - rect.top) * H) / rect.height;
  // clicking a place of interest walks there and uses it
  let hit = HOTSPOTS.find((h) => Math.hypot(h.x - x, h.y - y) < 46);
  if (!hit && x > 722 && x < 878 && y > 280 && y < 410) hit = HOTSPOTS.find((h) => h.id === "stall");
  if (!hit && x > 350 && x < 424 && y > 6 && y < 156) hit = HOTSPOTS.find((h) => h.id === "lighthouse");
  if (!hit && x < 236 && y > 400 && y < 620) hit = HOTSPOTS.find((h) => h.id === "reef");
  if (!hit && x > 940 && y < 250) hit = HOTSPOTS.find((h) => h.id === "cliffs");
  if (!hit && x > BOARD_BOX.x1 && x < BOARD_BOX.x2 && y > BOARD_BOX.y1 && y < BOARD_BOX.y2) hit = HOTSPOTS.find((h) => h.id === "board");
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
$("notices-close").onclick = closeNotices;
$("ntab-buy").onclick = () => {
  ntab = "buy";
  renderNotices();
};
$("ntab-pin").onclick = () => {
  ntab = "pin";
  renderNotices();
};
$("notices").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.pin) pinDefaults(d.pin);
  else if (d.pq) pin.qty += Number(d.pq);
  else if (d.pp) pin.price = Math.max(1, (Math.round(pin.price) || 1) + Number(d.pp));
  else if (d.pinGo !== undefined) return pinNotice();
  else if (d.bq) {
    const l = S.market.notices.listings.find((x) => x.id === Number(d.bq));
    buyQty[d.bq] = Math.max(1, Math.min(l.qty, (buyQty[d.bq] ?? l.qty) + Number(d.d)));
  } else if (d.buy) return buyNotice(Number(d.buy), Number(d.qty));
  else if (d.cancel) return takeDown(Number(d.cancel));
  else return;
  renderNotices();
});
$("notices").addEventListener("input", (e) => {
  if (e.target.id !== "pin-price") return;
  const v = Math.round(Number(e.target.value));
  if (v >= 1) pin.price = v;
  $("pin-sum").innerHTML = pinSummary();
});
$("notices").addEventListener("focusout", (e) => {
  if (e.target.id === "pin-price") e.target.value = pin.price; // show the price that will be used (no re-render: a click may be on its way)
});
$("notices").addEventListener("keydown", (e) => e.key === "Enter" && e.target.id === "pin-price" && pinNotice());
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
  S.tide.height = tideHeight(nowMs());
  S.storm.level = stormLevel(nowMs());

  if (started && !busy && !S.shopOpen && !S.boardOpen) {
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
