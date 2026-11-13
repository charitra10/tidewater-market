// The fast-forward page: runs web/sim-engine.js in steps, draws the week as it
// happens, and shows the working behind any price at any moment (the same
// why-functions the stall uses).
import { createSim, step, summary, inject, SHOCKS, DEFAULTS, DAY_MS, STEP_MS } from "./sim-engine.js";
import { bidWhy, askWhy, dealerBidWhy, RAW } from "./merchant.js";
import { tideAt, stormAt, eventAt, tideName, EVENT_TEXT } from "./tide.js";

const $ = (id) => document.getElementById(id);
const WEEK = 7 * DAY_MS;
const C = { kelp: "#3f8f5a", driftwood: "#9a6b3c", ore: "#5b6470", pearl: "#c0587a", pickaxe: "#5b6470", boat: "#1f6f78", beacon: "#d9a441", maren: "#b8432f", silas: "#2c2a26", mainland: "#2f8f96", pockets: "#d9a441" };

let sim = null;
let running = false;
let seed = null; // the live market, once fetched
let hover = null; // index into sim.history
let pick = { kind: "bid", token: "ore" }; // whose working the moment panel shows
let owed = 0; // steps owed to the clock
let lastFrame = 0;
let lastDraw = 0;

const CHARTS = [
  {
    title: "Kelp and driftwood: what Maren pays",
    series: [
      { label: "Kelp", color: C.kelp, get: (s) => s.prices.kelp, why: { kind: "bid", token: "kelp" } },
      { label: "Driftwood", color: C.driftwood, get: (s) => s.prices.driftwood, why: { kind: "bid", token: "driftwood" } },
    ],
  },
  {
    title: "Ore and pearls: Maren (solid) and Silas (dashed)",
    series: [
      { label: "Ore", color: C.ore, get: (s) => s.prices.ore, why: { kind: "bid", token: "ore" } },
      { label: "Pearl", color: C.pearl, get: (s) => s.prices.pearl, why: { kind: "bid", token: "pearl" } },
      { label: "Silas: ore", color: C.ore, dash: true, get: (s) => s.silas.ore, why: { kind: "silas", token: "ore" } },
      { label: "Silas: pearl", color: C.pearl, dash: true, get: (s) => s.silas.pearl, why: { kind: "silas", token: "pearl" } },
    ],
  },
  {
    title: "What she asks for her wares",
    log: true,
    series: [
      { label: "Pickaxe", color: C.pickaxe, get: (s) => s.prices.pickaxe, why: { kind: "ask", token: "pickaxe" } },
      { label: "Boat", color: C.boat, get: (s) => s.prices.boat, why: { kind: "ask", token: "boat" } },
      { label: "Beacon lens", color: C.beacon, get: (s) => s.prices.beacon, why: { kind: "ask", token: "beacon" } },
    ],
    marks: "beacon",
  },
  {
    title: "Purses: Maren, Silas, the mainland, and all players' pockets",
    series: [
      { label: "Maren", color: C.maren, get: (s) => s.maren },
      { label: "Silas", color: C.silas, get: (s) => s.silasPurse },
      { label: "Mainland", color: C.mainland, get: (s) => s.mainland },
      { label: "Players", color: C.pockets, get: (s) => s.pockets },
    ],
    marks: "invest",
  },
  {
    title: "Her shelves",
    series: RAW.map((t) => ({ label: t[0].toUpperCase() + t.slice(1), color: C[t], get: (s) => s.stock[t] })),
  },
];

// ---------- the page ----------
function buildCharts() {
  $("charts").innerHTML =
    CHARTS.map(
      (c, i) =>
        `<div class="chart"><h3>${c.title}${c.series
          .map((s, j) => `<span class="key${s.why && s.why.kind === pick.kind && s.why.token === pick.token ? " on" : ""}" data-c="${i}" data-s="${j}" title="${s.why ? "Show its working" : ""}"><i style="background:${s.color}${s.dash ? ";opacity:.5" : ""}"></i>${s.label}</span>`)
          .join("")}</h3><canvas id="chart${i}"></canvas></div>`,
    ).join("") +
    `<div class="legend"><span><i style="background:rgba(47,143,150,.16)"></i>storm</span><span><i style="background:rgba(184,67,47,.35)"></i>Maren shut</span><span><i style="background:rgba(44,42,38,.25)"></i>Silas away</span><span>● investment</span><span>★ lighthouse lit</span><span>┊ something you threw at it</span></div>`;
  for (let i = 0; i < CHARTS.length; i++) {
    const cv = $(`chart${i}`);
    cv.addEventListener("mousemove", (e) => setHover(e, cv));
    cv.addEventListener("mouseleave", () => ((hover = null), draw()));
    cv.addEventListener("click", (e) => setHover(e, cv));
  }
}
$("charts").addEventListener("click", (e) => {
  const k = e.target.closest(".key");
  if (!k) return;
  const s = CHARTS[k.dataset.c].series[k.dataset.s];
  if (!s.why) return;
  pick = s.why;
  buildCharts();
  draw(true);
});

function setHover(e, cv) {
  if (!sim) return;
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const t = sim.start + x * WEEK;
  const h = sim.history;
  let best = 0;
  for (let i = 0; i < h.length; i++) if (Math.abs(h[i].t - t) < Math.abs(h[best].t - t)) best = i;
  hover = h.length && Math.abs(h[best].t - t) < 30 * 60_000 ? best : null;
  draw(true);
}

// ---------- drawing ----------
function draw(force = false) {
  const now = performance.now();
  if (!force && now - lastDraw < 100) return;
  lastDraw = now;
  if (!sim) return;
  for (let i = 0; i < CHARTS.length; i++) drawChart($(`chart${i}`), CHARTS[i]);
  const t = sim.t - sim.start;
  $("progress").style.width = `${Math.min(100, (t / WEEK) * 100)}%`;
  $("when").textContent = when(sim.t);
  renderMoment();
}

function drawChart(cv, chart) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const hgt = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) (cv.width = Math.round(w * dpr)), (cv.height = Math.round(hgt * dpr));
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const h = sim.history;
  const pad = { l: 40, r: 8, t: 8, b: 16 };
  const X = (t) => pad.l + ((t - sim.start) / WEEK) * (w - pad.l - pad.r);
  // the vertical scale: from the values so far
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of h) for (const se of chart.series) {
    const v = se.get(s);
    if (v == null || Number.isNaN(v)) continue;
    if (chart.log && v <= 0) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
  if (!chart.log) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  const f = chart.log ? Math.log : (v) => v;
  const [a, b] = chart.log ? [f(lo * 0.9), f(hi * 1.1)] : [lo, hi * 1.08];
  const Y = (v) => pad.t + (1 - (f(Math.max(v, chart.log ? lo * 0.9 : -Infinity)) - a) / (b - a)) * (hgt - pad.t - pad.b);
  // storms, and shut shops
  for (let i = 0; i < h.length; i++) {
    const x0 = X(h[i].t);
    const x1 = i + 1 < h.length ? X(h[i + 1].t) : x0 + 1;
    if (h[i].storm) (ctx.fillStyle = "rgba(47,143,150,.16)"), ctx.fillRect(x0, pad.t, x1 - x0, hgt - pad.t - pad.b);
    if (h[i].closed.maren) (ctx.fillStyle = "rgba(184,67,47,.35)"), ctx.fillRect(x0, pad.t, x1 - x0, 5);
    if (h[i].closed.silas || h[i].silasAway) (ctx.fillStyle = "rgba(44,42,38,.25)"), ctx.fillRect(x0, pad.t + 6, x1 - x0, 4);
  }
  // days
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "#6b6357";
  ctx.strokeStyle = "rgba(107,99,87,.18)";
  ctx.lineWidth = 1;
  for (let d = 0; d <= 7; d++) {
    const x = X(sim.start + d * DAY_MS);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, hgt - pad.b);
    ctx.stroke();
    if (d < 7) ctx.fillText(new Date(sim.start + d * DAY_MS + DAY_MS / 2).toLocaleDateString(undefined, { weekday: "short" }), x + 4, hgt - 4);
  }
  // the scale
  ctx.textAlign = "right";
  for (const v of chart.log ? [lo, Math.sqrt(lo * hi), hi] : [0, hi / 2, hi]) {
    const y = Y(v);
    ctx.fillText(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10, pad.l - 5, y + 3);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }
  ctx.textAlign = "left";
  // the lines
  for (const se of chart.series) {
    ctx.strokeStyle = se.color;
    ctx.globalAlpha = se.dash ? 0.6 : 1;
    ctx.setLineDash(se.dash ? [5, 4] : []);
    ctx.lineWidth = se.why && se.why.kind === pick.kind && se.why.token === pick.token ? 2.4 : 1.6;
    ctx.beginPath();
    let on = false;
    for (const s of h) {
      const v = se.get(s);
      if (v == null || (chart.log && v <= 0)) {
        on = false;
        continue;
      }
      if (on) ctx.lineTo(X(s.t), Y(v));
      else ctx.moveTo(X(s.t), Y(v)), (on = true);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  // what happened: investments, lighthouses lit, shocks
  for (const e of sim.story) {
    const x = X(e.t);
    if (e.kind === "shock") {
      ctx.strokeStyle = "rgba(184,67,47,.8)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, hgt - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (e.kind === "invest" && chart.marks === "invest") {
      ctx.fillStyle = C.green ?? "#3f8f5a";
      ctx.beginPath();
      ctx.arc(x, hgt - pad.b - 5, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "beacon" && chart.marks === "beacon") {
      ctx.fillStyle = C.beacon;
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("★", x - 5, pad.t + 22);
      ctx.font = "10px system-ui, sans-serif";
    }
  }
  // the moment being hovered
  if (hover != null && h[hover]) {
    const x = X(h[hover].t);
    ctx.strokeStyle = "rgba(44,42,38,.6)";
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, hgt - pad.b);
    ctx.stroke();
    for (const se of chart.series) {
      const v = se.get(h[hover]);
      if (v == null || (chart.log && v <= 0)) continue;
      ctx.fillStyle = se.color;
      ctx.beginPath();
      ctx.arc(x, Y(v), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function when(t) {
  const d = new Date(t);
  const day = Math.floor((t - sim.start) / DAY_MS) + 1;
  return `Day ${Math.min(day, 7)} · ${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

// ---------- one moment, and the working behind a price ----------
const n1 = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
function renderMoment() {
  const s = hover != null ? sim.history[hover] : sim.history.at(-1);
  if (!s) return;
  const t = s.t;
  const tide = tideAt(t);
  const ev = eventAt(t);
  const market = {
    ...s.books,
    floor: sim.policy.floor,
    ceiling: sim.policy.ceiling,
    exportPrice: sim.policy.exportPrice,
    tide,
    storm: { ...stormAt(t), active: s.storm },
    event: ev,
  };
  let why;
  let title;
  if (pick.kind === "silas") {
    if (!s.books.dealer) why = null;
    else why = dealerBidWhy({ ...s.books.dealer, ceiling: sim.silas.ceiling, cityPrice: sim.silas.cityPrice, tide, storm: { active: s.storm } }, pick.token);
    title = `What Silas pays for ${pick.token === "ore" ? "ore" : "a pearl"}`;
  } else if (pick.kind === "ask") {
    why = askWhy(market, pick.token);
    title = `What Maren asks for a ${pick.token === "beacon" ? "beacon lens" : pick.token}`;
  } else {
    why = bidWhy(market, pick.token);
    title = `What Maren pays for ${pick.token === "pearl" ? "a pearl" : pick.token === "ore" ? "a lump of ore" : pick.token}`;
  }
  const rows = why
    ? why.steps.map((x) => `<tr><td>${x.note}</td><td class="n">${x.value != null ? n1(x.value) : `×${Math.round(x.factor * 100) / 100}`}</td></tr>`).join("") +
      `<tr class="sum"><td>${title.replace(/^What /, "So ")}</td><td class="n">${n1(why.price)}</td></tr>` +
      why.limits.filter((l) => l.binds).map((l) => `<tr class="lim"><td>${l.note}</td><td class="n">${n1(l.value)}</td></tr>`).join("")
    : `<tr><td>Silas wasn't in town.</td><td></td></tr>`;
  const weather = [tideName(tide), s.storm ? "storm" : "", ev.active ? EVENT_TEXT[ev.kind]?.name ?? ev.kind : ""].filter(Boolean).join(" · ");
  $("moment").innerHTML = `<h2>${hover != null ? "That moment" : "Right now"}</h2>
    <div class="when">${when(t)}</div><div class="sub">${weather}${s.closed.maren ? " · <b>Maren's stall is shut</b>" : ""}${s.closed.silas ? " · Silas is away" : ""}</div>
    <div class="sub">Maren ${s.maren} · Silas ${s.silasPurse} · mainland ${s.mainland} · players ${s.pockets} coins</div>
    <h3 style="font-size:14px;margin-top:10px">${title}</h3><table>${rows}</table>
    <p class="src">The same working as at the stall (${pick.kind === "silas" ? "dealerBidWhy" : pick.kind === "ask" ? "askWhy" : "bidWhy"} in merchant.js), from her books at that moment. Pick another price in a chart's key.</p>`;
}

// ---------- the story so far ----------
let storyShown = 0;
function renderStory() {
  if (sim.story.length === storyShown) return;
  storyShown = sim.story.length;
  $("story").innerHTML = sim.story
    .slice(-80)
    .reverse()
    .map((e) => `<li class="${e.kind}"><b>${when(e.t).replace(/^Day \d · /, "")}</b>${e.text}</li>`)
    .join("");
}

// ---------- the end of the week ----------
function renderSummary() {
  const s = summary(sim);
  const f = sim.flow;
  const range = ([a, b]) => `${n1(a)} – ${n1(b)}`;
  const findings = [];
  const ore = s.prices.ore;
  findings.push(`Ore went from ${n1(ore[0])} to ${n1(ore[1])} a lump at Maren's counter: her bid follows her shelf, her purse, the tide and what players have sold her lately.`);
  if (s.closures.maren || s.closures.silas) findings.push(`Maren shut ${s.closures.maren} ${s.closures.maren === 1 ? "time" : "times"} and Silas ${s.closures.silas}; players invested ${s.invested} coins and got ${s.repaid} back so far.`);
  else findings.push("Neither merchant went broke this week.");
  const madeMoney = f.exports + f.silasShipped;
  if (madeMoney > 0) findings.push(`New coin came in from the mainland: ${Math.round(f.exports)} for Maren's exports and ${Math.round(f.silasShipped)} for Silas's shipments. Maren paid players ${Math.round(f.marenPaid)} for raw goods and took ${Math.round(f.marenTook)} for tools and lenses.`);
  if (s.money.maren > 3 * (sim.history[0]?.maren ?? 1)) findings.push(`Maren ended the week much richer than she began (${s.money.maren} coins): the mainland's money mostly piles up in her purse, because her bids don't rise when she is rich.`);
  if (s.beacons) findings.push(`${s.beacons} ${s.beacons === 1 ? "player" : "players"} lit the lighthouse.`);
  else findings.push("Nobody saved up enough to light the lighthouse.");
  $("summary").hidden = false;
  $("summary").innerHTML = `<h2>The week in numbers</h2><div class="cols">
    <table><tr><td colspan="2"><b>Maren's prices (low – high)</b></td></tr>${RAW.map((t) => `<tr><td>She paid for ${t}</td><td class="n">${range(s.prices[t])}</td></tr>`).join("")}
      ${["pickaxe", "boat", "beacon"].map((t) => `<tr><td>She asked for a ${t === "beacon" ? "lens" : t}</td><td class="n">${range(s.prices[t])}</td></tr>`).join("")}
      ${Object.entries(s.silas).map(([t, r]) => `<tr><td>Silas paid for ${t}</td><td class="n">${range(r)}</td></tr>`).join("")}</table>
    <table><tr><td colspan="2"><b>What happened</b></td></tr>
      <tr><td>Trips foraging</td><td class="n">${s.forages}</td></tr><tr><td>Deals at the counters</td><td class="n">${s.trades}</td></tr>
      <tr><td>Sales off the notice board</td><td class="n">${s.boardSales}</td></tr><tr><td>Her wanted orders filled</td><td class="n">${s.ordersFilled}</td></tr>
      <tr><td>Things she crafted</td><td class="n">${s.crafted}</td></tr><tr><td>Loads exported</td><td class="n">${s.exports}</td></tr>
      <tr><td>Pickaxes broken</td><td class="n">${s.pickaxesBroken}</td></tr><tr><td>Lighthouses lit</td><td class="n">${s.beacons}</td></tr>
      <tr><td>Times a merchant shut</td><td class="n">${s.closures.maren + s.closures.silas}</td></tr><tr><td>Invested / repaid</td><td class="n">${s.invested} / ${s.repaid}</td></tr></table>
    <table><tr><td colspan="2"><b>Where the coins are</b></td></tr><tr><td>Maren</td><td class="n">${s.money.maren}</td></tr><tr><td>Silas</td><td class="n">${s.money.silas}</td></tr>
      <tr><td>The mainland's purse</td><td class="n">${s.money.mainland}</td></tr><tr><td>Players' pockets</td><td class="n">${s.money.pockets}</td></tr></table>
  </div><h3 style="margin-top:12px;font-size:15px">What it shows</h3><ul>${findings.map((x) => `<li>${x}</li>`).join("")}</ul>`;
}

// ---------- running it ----------
async function fresh() {
  running = false;
  $("play").textContent = "Play";
  $("summary").hidden = true;
  hover = null;
  storyShown = 0;
  const live = $("from").value === "live";
  let from = DEFAULTS;
  let start = Date.now();
  if (live) {
    try {
      seed ??= await fetch("/api/sim-seed").then((r) => (r.ok ? r.json() : Promise.reject()));
      from = { maren: seed.maren, policy: seed.policy, silas: seed.silas, mainland: seed.mainland };
      start = seed.now;
      $("seeded").textContent = "starting from the live market";
    } catch {
      $("seeded").textContent = "couldn't reach the live market: starting from a fresh one";
    }
  } else $("seeded").textContent = "starting from a fresh market";
  sim = createSim({ seed: Number($("seed").value) || 1, players: Number($("players").value), mainlandPerDay: Number($("mainland").value), from, start });
  $("shocks").innerHTML = Object.entries(SHOCKS).map(([k, label]) => `<button data-shock="${k}">${label}</button>`).join("");
  renderStory();
  draw(true);
}

function frame(now) {
  const dt = Math.min(1000, now - (lastFrame || now)); // (a slow or hidden tab gets few frames: count the time anyway)
  lastFrame = now;
  if (running && sim) {
    const perSecond = WEEK / STEP_MS / Number($("speed").value);
    owed += (dt / 1000) * perSecond;
    const budget = performance.now() + 12;
    while (owed >= 1 && performance.now() < budget && sim.t - sim.start < WEEK) {
      step(sim);
      owed -= 1;
    }
    if (owed > perSecond) owed = perSecond; // (a slow machine runs slower, not in jumps)
    if (sim.t - sim.start >= WEEK) {
      running = false;
      $("play").textContent = "Play";
      $("play").disabled = true;
      renderSummary();
      draw(true);
    } else draw();
    renderStory();
  }
  requestAnimationFrame(frame);
}

$("play").onclick = () => {
  running = !running;
  $("play").textContent = running ? "Pause" : "Play";
};
$("restart").onclick = async () => {
  $("play").disabled = false;
  await fresh();
};
for (const id of ["players", "mainland", "seed", "from"]) $(id).addEventListener("change", () => $("restart").onclick());
$("shocks").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-shock]");
  if (!b || !sim) return;
  inject(sim, b.dataset.shock);
  if (b.dataset.shock !== "flood") b.disabled = true;
  renderStory();
  draw(true);
});
addEventListener("resize", () => draw(true));

buildCharts();
await fresh();
requestAnimationFrame(frame);
