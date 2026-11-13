// The village of Tidewater, drawn with plain canvas shapes (no image files).
// Also knows where you can walk and where the interesting spots are.

import { iconImage } from "./icons.js";
import { TIDE_TEXT, STORM_TEXT } from "./tide.js";

export const W = 1280;
export const H = 720;

// The shoreline, top to bottom. Sea is to the left.
const SHORE = [[300, -20], [292, 110], [362, 215], [452, 300], [432, 420], [472, 540], [522, 640], [500, 740]];
const CLIFF = [[925, -10], [955, 92], [1012, 150], [1000, 206], [1092, 238], [1182, 216], [1290, 252], [1290, -10]];
const PIER = { x1: 236, x2: 505, y1: 546, y2: 574 };
const BLOCKS = [
  { x1: 726, x2: 874, y1: 318, y2: 404 }, // the stall
  { x1: 1022, x2: 1142, y1: 520, y2: 600 }, // the cottage
  { x1: 356, x2: 416, y1: 92, y2: 148 }, // the lighthouse
  { x1: 936, x2: 1014, y1: 486, y2: 508 }, // the notice board
  { x1: 494, x2: 528, y1: 288, y2: 306 }, // Silas's crates
  { x1: 1160, x2: 1220, y1: 548, y2: 574 }, // the workbench
];

export const HOTSPOTS = [
  { id: "shore", x: 506, y: 404, r: 72, label: "Tide pools", verb: "Comb the shore", cost: 1 },
  { id: "cliffs", x: 1046, y: 268, r: 72, label: "The cliffs", verb: "Mine the cliffs", cost: 2, tool: "pickaxe" },
  { id: "reef", x: 262, y: 560, r: 62, label: "The reef", verb: "Row out to the reef", cost: 3, tool: "boat" },
  { id: "stall", x: 800, y: 432, r: 78, label: "Maren's stall", verb: "Talk to Maren", pillUp: 176 },
  { id: "lighthouse", x: 424, y: 170, r: 72, label: "The old lighthouse", verb: "Climb the lighthouse", pillUp: 44 },
  { id: "board", x: 975, y: 534, r: 62, label: "The notice board", verb: "Read the notice board", pillUp: 150 },
  { id: "bench", x: 1190, y: 594, r: 50, label: "The workbench", verb: "Use the workbench", pillUp: 84 },
  // the village's pitches for player shops (see PITCHES)
  { id: "pitch0", x: 1086, y: 432, r: 40, label: "A market pitch", verb: "Visit the pitch", pillUp: 88, pitch: 0 },
  { id: "pitch1", x: 1150, y: 504, r: 40, label: "A market pitch", verb: "Visit the pitch", pillUp: 88, pitch: 1 },
  { id: "pitch2", x: 640, y: 398, r: 40, label: "A market pitch", verb: "Visit the pitch", pillUp: 88, pitch: 2 },
  { id: "pitch3", x: 706, y: 526, r: 40, label: "A market pitch", verb: "Visit the pitch", pillUp: 88, pitch: 3 },
  // only while the dealer is in town (`S.dealer`)
  { id: "dealer", x: 504, y: 344, r: 50, label: "Silas, the dealer", verb: "Trade with Silas", pillUp: 124, needs: "dealer" },
];
/// Where each pitch's table stands (the hotspot is just in front of it).
export const PITCHES = [{ x: 1086, y: 404 }, { x: 1150, y: 476 }, { x: 640, y: 370 }, { x: 706, y: 498 }];
/// Is this place there right now? (Silas's pitch only while he is in town.)
export const present = (h, S) => !h.needs || Boolean(S[h.needs]);
/// Where the notice board stands (for clicks).
export const BOARD_BOX = { x1: 930, x2: 1020, y1: 400, y2: 512 };

export function shoreX(y) {
  for (let i = 0; i < SHORE.length - 1; i++) {
    const [x1, y1] = SHORE[i];
    const [x2, y2] = SHORE[i + 1];
    if (y >= y1 && y <= y2) return x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);
  }
  return SHORE[0][0];
}

function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function walkable(x, y) {
  if (x >= PIER.x1 && x <= PIER.x2 && y >= PIER.y1 && y <= PIER.y2) return true;
  if (x > W - 18 || y < 34 || y > H - 14) return false;
  if (x < shoreX(y) + 16) return false;
  if (inPoly(CLIFF, x, y)) return false;
  for (const b of BLOCKS) if (x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2) return false;
  // tree trunks (the player steers round them)
  for (const [tx, ty, s] of TREES) if (((x - tx) / (14 * s)) ** 2 + ((y - ty + 2) / (8 * s)) ** 2 < 1) return false;
  return true;
}

// ---------- small helpers ----------
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(ctx, pts, dx = 0) {
  ctx.moveTo(pts[0][0] + dx, pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2 + dx;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0] + dx, pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0] + dx, last[1]);
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function ellipse(ctx, x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

// scenery that never changes, placed once
const rand = rng(11);
const TUFTS = [];
while (TUFTS.length < 170) {
  const x = 420 + rand() * 850;
  const y = 30 + rand() * 680;
  if (x > shoreX(y) + 105 && !inPoly(CLIFF, x, y)) TUFTS.push({ x, y, flower: rand() < 0.16, hue: rand() });
}
const PEBBLES = [];
while (PEBBLES.length < 60) {
  const y = rand() * 720;
  const x = shoreX(y) + 14 + rand() * 60;
  PEBBLES.push({ x, y, r: 1.5 + rand() * 2.5, shell: rand() < 0.2 });
}
// what a low tide uncovers on the wet sand: weed, stones and shells, each
// `off` px from the shoreline (seaward), so they show as the water drains
const EXPOSED = [];
for (let y = 60; y < 710; y += 16 + rand() * 20) {
  if (y > 528 && y < 592) continue; // under the pier
  const r = rand();
  EXPOSED.push({ y, off: -25 + rand() * 14, kind: r < 0.5 ? "weed" : r < 0.82 ? "stone" : "shell", size: 2.6 + rand() * 2.8, turn: rand() * 3 });
}
// driftwood the high tide throws up the beach: [y, px from the shoreline, angle]
const WASHED = [[268, 27, -0.25], [474, 31, 0.45], [636, 22, -0.6]];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const TREES = [
  [612, 96, 1], [700, 62, 0.9], [770, 128, 1.1], [868, 96, 1], [610, 642, 1.1], [716, 676, 0.95],
  [948, 656, 1.05], [1214, 430, 1], [1178, 338, 0.9], [652, 540, 0.85], [1238, 640, 1.1], [905, 560, 0.8],
];
const PATHS = [
  [[800, 448], [680, 440], [560, 412]],
  [[800, 448], [900, 380], [980, 310], [1046, 276]],
  [[790, 440], [690, 330], [560, 240], [436, 178]],
  [[556, 418], [530, 500], [506, 560]],
  [[820, 452], [940, 520], [1080, 606]],
];

// ---------- the pieces ----------
function drawSea(ctx, t, wx, rough = 0) {
  const g = ctx.createLinearGradient(0, 0, 560, 0);
  g.addColorStop(0, "#1c5b78");
  g.addColorStop(1, "#3193a1");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.lineCap = "round";
  // more and whiter wave crests in a storm
  for (let i = 0; i < 26 + Math.round(rough * 30); i++) {
    const y = ((18 + i * 28 + Math.sin(i * 2.1) * 8) % 740) + (i >= 26 ? 9 : 0);
    const x = ((i * 137 + t * (8 + (i % 4) * 3) * (1 + rough * 1.5)) % 620) - 60;
    if (x > shoreX(y) + wx - 24) continue;
    ctx.strokeStyle = `rgba(220,245,245,${0.1 + 0.1 * Math.sin(t * 0.9 + i) + 0.4 * rough})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 14, y - 5, x + 28, y);
    ctx.quadraticCurveTo(x + 42, y + 5, x + 56, y);
    ctx.stroke();
  }
}

function drawReef(ctx, t, lvl) {
  // rocks under the water, foam rings, and a buoy; at low water the rocks stand out
  const out = clamp01((-lvl - 0.2) / 0.9); // 0 at mid tide, 1 at low water
  const deep = clamp01(lvl); // 1 at high water
  for (const [x, y, r] of [[120, 470, 30], [170, 500, 22], [96, 520, 18], [150, 440, 16]]) {
    ellipse(ctx, x, y, r * 1.25, r * 0.8, `rgba(20,60,74,${0.55 - 0.2 * deep})`);
    ctx.strokeStyle = `rgba(235,250,250,${(0.25 + 0.2 * Math.sin(t * 1.4 + x)) * (1 - 0.5 * deep)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.25 + 4 + Math.sin(t + x) * 2, r * 0.8 + 3, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const [x, y, rx, ry, need] of [[132, 478, 12, 7, -1], [168, 500, 8, 5, -1], [104, 520, 9, 5, 0.35], [152, 442, 8, 4.5, 0.55], [118, 458, 6, 3.5, 0.8]]) {
    const f = need < 0 ? Math.min(1.25, 0.75 + 0.5 * out - 0.55 * deep) : clamp01((out * 1.35 - need) * 2.5);
    if (f < 0.08) continue;
    ellipse(ctx, x, y, rx * f, ry * f, "#5d6f73");
    ellipse(ctx, x - rx * 0.25 * f, y - ry * 0.3 * f, rx * 0.45 * f, ry * 0.35 * f, "rgba(255,255,255,0.16)");
  }
  const bob = Math.sin(t * 1.7) * 3;
  ctx.save();
  ctx.translate(196, 452 + bob);
  ctx.rotate(Math.sin(t * 1.2) * 0.12);
  rr(ctx, -7, -16, 14, 20, 5);
  ctx.fillStyle = "#d8493a";
  ctx.fill();
  ctx.fillStyle = "#f6efe0";
  ctx.fillRect(-7, -9, 14, 5);
  ctx.fillStyle = "#3a3a3a";
  ctx.fillRect(-1, -24, 2, 9);
  ctx.restore();
}

function drawLand(ctx, t, wx) {
  // shallows just off the beach
  ctx.beginPath();
  smooth(ctx, SHORE, wx - 12);
  ctx.strokeStyle = "rgba(150,220,215,0.2)";
  ctx.lineWidth = 22;
  ctx.stroke();
  // wet sand from the water's edge (which moves with the tide), then dry sand
  ctx.beginPath();
  smooth(ctx, SHORE, wx);
  ctx.lineTo(W + 20, H + 20);
  ctx.lineTo(W + 20, -20);
  ctx.closePath();
  ctx.fillStyle = "#cdb783";
  ctx.fill();
  for (const e of EXPOSED) if (e.off > wx + 3) drawExposed(ctx, shoreX(e.y) + e.off, e.y, e);
  ctx.beginPath();
  smooth(ctx, SHORE, wx + 4);
  ctx.strokeStyle = "rgba(110,90,50,0.14)"; // damp where the water just was
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.beginPath();
  smooth(ctx, SHORE, Math.max(10 + Math.sin(t * 0.8) * 2, wx + 3));
  ctx.lineTo(W + 20, H + 20);
  ctx.lineTo(W + 20, -20);
  ctx.closePath();
  ctx.fillStyle = "#ecd9a8";
  ctx.fill();
  // foam
  ctx.beginPath();
  smooth(ctx, SHORE, wx - 2 + Math.sin(t * 0.8) * 4);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.beginPath();
  smooth(ctx, SHORE, wx - 16 + Math.sin(t * 0.8 + 1.4) * 5);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 2;
  ctx.stroke();
  for (const p of PEBBLES) {
    ellipse(ctx, p.x, p.y, p.r * 1.3, p.r, p.shell ? "#f7ede0" : "#c2ab78");
  }
  // grass
  const grass = SHORE.map(([x, y], i) => [x + 86 + Math.sin(i * 1.9) * 14, y]);
  ctx.beginPath();
  smooth(ctx, grass);
  ctx.lineTo(W + 20, H + 20);
  ctx.lineTo(W + 20, -20);
  ctx.closePath();
  ctx.fillStyle = "#8dbb6f";
  ctx.fill();
  ctx.beginPath();
  smooth(ctx, grass, 16);
  ctx.lineTo(W + 20, H + 20);
  ctx.lineTo(W + 20, -20);
  ctx.closePath();
  ctx.fillStyle = "#83b365";
  ctx.fill();
  // paths
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const [width, colour] of [[34, "#cdb98a"], [26, "#e2cf9f"]]) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    for (const path of PATHS) {
      ctx.beginPath();
      smooth(ctx, path);
      ctx.stroke();
    }
  }
  // tufts and flowers
  for (const f of TUFTS) {
    if (f.flower) {
      ellipse(ctx, f.x, f.y, 2.6, 2.6, f.hue < 0.5 ? "#fff6d8" : "#f6c1d2");
      ellipse(ctx, f.x, f.y, 1, 1, "#e9a534");
    } else {
      ctx.strokeStyle = "#6c9c52";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(f.x - 4, f.y);
      ctx.lineTo(f.x - 2, f.y - 6);
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(f.x, f.y - 8);
      ctx.moveTo(f.x + 4, f.y);
      ctx.lineTo(f.x + 3, f.y - 6);
      ctx.stroke();
    }
  }
}

// ---------- storms ----------
const RAIN = Array.from({ length: 170 }, (_, i) => ({ x: (i * 397) % W, y: (i * 211) % H, speed: 520 + ((i * 53) % 260), len: 10 + (i % 7) * 2 }));
const CLOUDS = [[80, 26, 1.2], [380, 8, 1], [640, 34, 1.3], [920, 12, 1.1], [1180, 30, 1]];

/// The sky closes in, cloud drifts over, rain, and now and then lightning.
/// `level` is 0 (calm) .. 1 (the storm at full blow).
// ---------- events (see eventAt in tide.js) ----------
/// Colour the water (drawn before the land, so only the sea takes it). The
/// "color" blend keeps the waves' light and dark and swaps in the new hue.
function tintSea(ctx, colour, blend = "source-over") {
  ctx.globalCompositeOperation = blend;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
}
/// A flat calm: the still water catches the light.
const GLINTS = (() => {
  const r = rng(77);
  return Array.from({ length: 34 }, () => {
    const y = 40 + r() * 640;
    return { x: 20 + r() * (shoreX(y) - 70), y, w: 6 + r() * 14, k: r() * 6 };
  });
})();
function drawGlints(ctx, t) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const g of GLINTS) {
    const a = Math.max(0, Math.sin(t * 1.3 + g.k * 2));
    if (a < 0.05) continue;
    ctx.globalAlpha = 0.75 * a;
    ctx.beginPath();
    ctx.moveTo(g.x - g.w / 2, g.y);
    ctx.lineTo(g.x + g.w / 2, g.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
/// Fog: banks of white drifting in off the sea, thickest over the water.
function drawFog(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, 700, 0);
  g.addColorStop(0, "rgba(236,240,240,0.62)");
  g.addColorStop(0.55, "rgba(236,240,240,0.38)");
  g.addColorStop(1, "rgba(236,240,240,0.1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 9; i++) {
    const x = ((i * 173 + t * (8 + i)) % (W + 400)) - 200;
    const y = 80 + ((i * 97) % 560);
    ellipse(ctx, x, y, 170, 34, "rgba(245,247,247,0.22)");
  }
}
/// A shipwreck: a broken hull on the shore, and cargo along the tideline.
function drawWreck(ctx, t) {
  const x = 470;
  const y = 470;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.35);
  ctx.fillStyle = "#5e4128";
  ctx.beginPath();
  ctx.moveTo(-46, -6);
  ctx.quadraticCurveTo(-30, 18, 0, 18);
  ctx.quadraticCurveTo(30, 18, 40, -2);
  ctx.lineTo(28, -10);
  ctx.lineTo(10, -2);
  ctx.lineTo(-8, -12);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#3f2b1b";
  ctx.lineWidth = 2;
  for (const dx of [-24, -6, 12, 28]) {
    ctx.beginPath();
    ctx.moveTo(dx, -6);
    ctx.lineTo(dx + 2, 14);
    ctx.stroke();
  }
  ctx.fillStyle = "#6e5034"; // the broken mast
  ctx.fillRect(-6, -40, 4, 32);
  ctx.restore();
  // crates and a coil of rope bobbing at the water's edge
  const bob = Math.sin(t * 2) * 1.5;
  ctx.fillStyle = "#a07444";
  ctx.fillRect(500, 410 + bob, 14, 12);
  ctx.fillRect(452, 512 - bob, 12, 11);
  ctx.strokeStyle = "#c9a24f";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(520, 500 + bob, 6, 0, Math.PI * 2);
  ctx.stroke();
}
/// The lantern festival: bunting over the stall, lanterns glowing after dark.
function drawBunting(ctx, t, night) {
  const colours = ["#d9534f", "#e3b24f", "#2f8f96", "#7a5aa6"];
  // above the awning (not across Maren's face), then down to the notice board's roof
  const strings = [
    [[724, 262], [876, 262]],
    [[876, 262], [1012, 424]],
  ];
  ctx.fillStyle = "#6e5034"; // two poles on the stall's corners to hang it from
  ctx.fillRect(722, 260, 3, 40);
  ctx.fillRect(875, 260, 3, 40);
  for (const [[x1, y1], [x2, y2]] of strings) {
    const n = 9;
    const sag = 18;
    const at = (k) => [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k + Math.sin(Math.PI * k) * sag];
    ctx.strokeStyle = "rgba(60,50,40,0.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const [x, y] = at(i / 20);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    for (let i = 1; i < n; i++) {
      const [x, y] = at(i / n);
      const sway = Math.sin(t * 2 + i) * 1.5;
      ctx.fillStyle = colours[i % colours.length];
      ctx.beginPath();
      ctx.moveTo(x - 5, y);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x + sway, y + 11);
      ctx.closePath();
      ctx.fill();
      if (night && i % 2 === 0) ellipse(ctx, x, y + 16, 5, 6, `rgba(255,${190 + (i % 3) * 20},90,${0.75 + 0.2 * Math.sin(t * 3 + i)})`);
    }
  }
}
/// The workbench by the cottage, where players make their own rope and pickaxes.
function drawWorkbench(ctx, t) {
  const x = 1190;
  const y = 566;
  ellipse(ctx, x, y + 4, 36, 6, "rgba(30,60,30,0.2)");
  ctx.fillStyle = "#6e5034";
  ctx.fillRect(x - 26, y - 18, 5, 22);
  ctx.fillRect(x + 21, y - 18, 5, 22);
  ctx.fillStyle = "#946a40";
  ctx.fillRect(x - 30, y - 24, 60, 8);
  ctx.fillStyle = "#7d5a39";
  ctx.fillRect(x - 30, y - 17, 60, 2);
  // a coil of rope and a saw on the top
  ctx.strokeStyle = "#c9a24f";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(x - 12, y - 27, 7, 3.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#8d939b";
  ctx.beginPath();
  ctx.moveTo(x + 2, y - 26);
  ctx.lineTo(x + 22, y - 28);
  ctx.lineTo(x + 22, y - 24);
  ctx.lineTo(x + 2, y - 24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#6e5034";
  ctx.fillRect(x - 2, y - 28, 5, 5);
}

function drawStorm(ctx, t, level) {
  if (level <= 0) return;
  ctx.fillStyle = `rgba(24,32,48,${0.36 * level})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.6 * level;
  for (const [x0, y, s] of CLOUDS) {
    const x = ((x0 + t * 16 * s) % (W + 320)) - 160;
    ellipse(ctx, x - 70 * s, y + 14, 80 * s, 24 * s, "#434b5b");
    ellipse(ctx, x + 60 * s, y + 12, 90 * s, 28 * s, "#545c6d");
    ellipse(ctx, x, y, 120 * s, 34 * s, "#4a5263");
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = `rgba(200,215,235,${0.5 * level})`;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < Math.round(RAIN.length * level); i++) {
    const r = RAIN[i];
    const y = ((r.y + t * r.speed) % (H + 40)) - 20;
    const x = ((r.x + t * r.speed * 0.28) % (W + 40)) - 20;
    ctx.moveTo(x, y);
    ctx.lineTo(x - r.len * 0.28, y - r.len);
  }
  ctx.stroke();
  const flash = lightningAt(t, level);
  if (flash) {
    ctx.fillStyle = `rgba(240,245,255,${flash})`;
    ctx.fillRect(0, 0, W, H);
  }
}

/// Lightning at time `t` (seconds): a double flash about every seven seconds
/// at the height of a storm. Returns how bright, 0 when dark (the game plays
/// thunder from the same clock).
export function lightningAt(t, level) {
  if (level <= 0.85) return 0;
  const k = (t % 7.3) / 7.3;
  return k < 0.012 ? 0.5 : k > 0.03 && k < 0.04 ? 0.28 : 0;
}

/// A bit of weed, a stone or a shell left on the wet sand by the falling tide.
function drawExposed(ctx, x, y, e) {
  if (e.kind === "stone") {
    ellipse(ctx, x, y, e.size * 1.5, e.size, "#9b9585");
    ellipse(ctx, x - e.size * 0.4, y - e.size * 0.35, e.size * 0.6, e.size * 0.4, "rgba(255,255,255,0.22)");
  } else if (e.kind === "shell") {
    ellipse(ctx, x, y, e.size * 0.9, e.size * 0.7, "#f4e7d4");
  } else {
    ctx.strokeStyle = "#3f6d47";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = e.turn + i * 0.9;
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(a) * e.size * 2, y + Math.sin(a) * e.size, x + Math.cos(a + 0.4) * e.size * 3, y + Math.sin(a + 0.4) * e.size * 1.6);
    }
    ctx.stroke();
  }
}

/// Driftwood the high tide has thrown up the beach.
function drawWashedUp(ctx, lvl) {
  const a = clamp01((lvl - 0.35) * 2.2);
  if (!a) return;
  ctx.globalAlpha = a;
  for (const [y, off, ang] of WASHED) {
    ctx.save();
    ctx.translate(shoreX(y) + off, y);
    ctx.rotate(ang);
    rr(ctx, -16, -3.5, 32, 7, 3.5);
    ctx.fillStyle = "#a9845a";
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawCliffs(ctx, t) {
  ctx.beginPath();
  ctx.moveTo(CLIFF[0][0], CLIFF[0][1]);
  for (const [x, y] of CLIFF.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = "#8f877c";
  ctx.fill();
  // lighter plateau on top
  ctx.beginPath();
  ctx.moveTo(960, -10);
  ctx.lineTo(985, 78);
  ctx.lineTo(1040, 128);
  ctx.lineTo(1034, 176);
  ctx.lineTo(1098, 198);
  ctx.lineTo(1184, 178);
  ctx.lineTo(1290, 212);
  ctx.lineTo(1290, -10);
  ctx.closePath();
  ctx.fillStyle = "#a79f93";
  ctx.fill();
  // strata on the face
  ctx.strokeStyle = "rgba(60,52,44,0.28)";
  ctx.lineWidth = 2;
  for (const [x1, y1, x2, y2] of [[1006, 190, 1090, 222], [1100, 222, 1180, 202], [1190, 204, 1280, 236], [962, 100, 1006, 140], [1020, 166, 1012, 196]]) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  // the old mine entrance
  ctx.beginPath();
  ctx.moveTo(1034, 221);
  ctx.lineTo(1034, 200);
  ctx.quadraticCurveTo(1049, 180, 1064, 203);
  ctx.lineTo(1064, 230);
  ctx.closePath();
  ctx.fillStyle = "#2b2622";
  ctx.fill();
  ctx.strokeStyle = "#7a5a3a";
  ctx.lineWidth = 5;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(1032, 222);
  ctx.lineTo(1034, 196);
  ctx.lineTo(1065, 200);
  ctx.lineTo(1066, 232);
  ctx.stroke();
  // boulders at the foot and ore veins that glint
  for (const [x, y, r] of [[1010, 232, 16], [1096, 256, 13], [1150, 240, 18], [978, 180, 12]]) {
    ellipse(ctx, x, y + 4, r * 1.2, r * 0.5, "rgba(0,0,0,0.12)");
    ellipse(ctx, x, y, r * 1.15, r * 0.85, "#7c756b");
    ellipse(ctx, x - r * 0.25, y - r * 0.25, r * 0.6, r * 0.4, "#948c81");
  }
  for (const [x, y, p] of [[1040, 214, 0], [1062, 224, 1.3], [1120, 226, 2.2], [1030, 196, 3.1], [1150, 212, 4]]) {
    const a = 0.55 + 0.45 * Math.sin(t * 2.2 + p);
    ellipse(ctx, x, y, 3.2, 2.4, `rgba(244,184,66,${a})`);
    ellipse(ctx, x + 5, y + 2, 1.8, 1.4, `rgba(255,224,140,${a})`);
  }
}

function drawPier(ctx, t, hasBoat) {
  ctx.fillStyle = "#5c4630";
  for (let x = PIER.x1 + 10; x < 470; x += 46) {
    ctx.fillRect(x, PIER.y1 - 5, 6, 40);
  }
  ctx.fillStyle = "#b08d62";
  ctx.fillRect(PIER.x1, PIER.y1, PIER.x2 - PIER.x1 + 6, PIER.y2 - PIER.y1);
  ctx.strokeStyle = "rgba(70,50,30,0.35)";
  ctx.lineWidth = 1.5;
  for (let x = PIER.x1 + 12; x < PIER.x2; x += 14) {
    ctx.beginPath();
    ctx.moveTo(x, PIER.y1);
    ctx.lineTo(x, PIER.y2);
    ctx.stroke();
  }
  ctx.fillStyle = "#8d6d47";
  ctx.fillRect(PIER.x1, PIER.y2 - 4, PIER.x2 - PIER.x1 + 6, 4);
  if (hasBoat) drawBoat(ctx, 212, 592 + Math.sin(t * 1.5) * 2.5, Math.sin(t * 1.1) * 0.04);
}

export function drawBoat(ctx, x, y, tilt = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ellipse(ctx, 0, 10, 40, 7, "rgba(15,50,66,0.35)");
  ctx.beginPath();
  ctx.moveTo(-38, -4);
  ctx.lineTo(38, -4);
  ctx.lineTo(28, 10);
  ctx.lineTo(-28, 10);
  ctx.closePath();
  ctx.fillStyle = "#9a6b3f";
  ctx.fill();
  ctx.fillStyle = "#b98552";
  ctx.fillRect(-38, -6, 76, 4);
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(-2, -50, 3, 46);
  ctx.beginPath();
  ctx.moveTo(3, -48);
  ctx.lineTo(30, -12);
  ctx.lineTo(3, -12);
  ctx.closePath();
  ctx.fillStyle = "#f4ead2";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-4, -40);
  ctx.lineTo(-22, -12);
  ctx.lineTo(-4, -12);
  ctx.closePath();
  ctx.fillStyle = "#e3d3ad";
  ctx.fill();
  ctx.restore();
}

function drawTidePools(ctx, t, lvl) {
  for (const [x, y, rx, ry] of [[462, 388, 22, 12], [476, 428, 17, 10], [448, 412, 12, 8]]) {
    ellipse(ctx, x, y, rx + 4, ry + 3, "#b9a474");
    ellipse(ctx, x, y, rx, ry, "#58a9b4");
    ellipse(ctx, x - rx * 0.3, y - ry * 0.3, rx * 0.35, ry * 0.3, "rgba(255,255,255,0.35)");
  }
  // kelp fronds: more of them show as the water drains
  ctx.lineCap = "round";
  const fronds = Math.round(Math.min(8, Math.max(1, 4 - lvl * 4)));
  for (const [x, y, p] of [[452, 394, 0], [470, 386, 1], [474, 432, 2], [486, 420, 3], [458, 420, 4], [444, 404, 5], [482, 398, 6], [466, 440, 7]].slice(0, fronds)) {
    const sway = Math.sin(t * 1.6 + p) * 3;
    ctx.strokeStyle = p % 2 ? "#3f8f5a" : "#2f7d4f";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - 5 + sway, y - 8, x + sway, y - 15);
    ctx.stroke();
  }
  // high water floods them
  const flood = clamp01((lvl - 0.3) / 0.7);
  if (flood > 0) {
    ellipse(ctx, 452, 410, 38, 34, `rgba(70,160,172,${0.6 * flood})`);
    ctx.strokeStyle = `rgba(235,250,250,${0.45 * flood})`;
    ctx.lineWidth = 1.5;
    for (const [x, y, r] of [[462, 396, 9], [476, 424, 7]]) {
      ctx.beginPath();
      ctx.ellipse(x, y, r + Math.sin(t * 2 + x) * 2, (r + Math.sin(t * 2 + x) * 2) * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // driftwood
  ctx.save();
  ctx.translate(522, 372);
  ctx.rotate(-0.35);
  rr(ctx, -20, -4, 40, 8, 4);
  ctx.fillStyle = "#b08a5e";
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(532, 438);
  ctx.rotate(0.5);
  rr(ctx, -14, -3, 28, 6, 3);
  ctx.fillStyle = "#a27d53";
  ctx.fill();
  ctx.restore();
}

function drawTree(ctx, x, y, s, t) {
  const sway = Math.sin(t * 0.9 + x) * 2;
  ellipse(ctx, x, y + 2, 24 * s, 8 * s, "rgba(30,60,30,0.2)");
  ctx.fillStyle = "#7a5a3a";
  ctx.fillRect(x - 4 * s, y - 26 * s, 8 * s, 28 * s);
  ellipse(ctx, x + sway * 0.4, y - 44 * s, 28 * s, 26 * s, "#4f8f55");
  ellipse(ctx, x - 12 * s + sway * 0.6, y - 34 * s, 18 * s, 16 * s, "#4f8f55");
  ellipse(ctx, x + 14 * s + sway * 0.6, y - 36 * s, 18 * s, 16 * s, "#4a8750");
  ellipse(ctx, x - 6 * s + sway, y - 52 * s, 16 * s, 13 * s, "#66a868");
}

function drawCottage(ctx, t, night) {
  const x = 1082;
  const y = 600;
  ellipse(ctx, x, y + 2, 70, 10, "rgba(30,60,30,0.2)");
  ctx.fillStyle = "#f2e6cf";
  ctx.fillRect(x - 54, y - 62, 108, 62);
  ctx.fillStyle = "#e0d2b6";
  ctx.fillRect(x - 54, y - 12, 108, 12);
  ctx.beginPath();
  ctx.moveTo(x - 66, y - 60);
  ctx.lineTo(x, y - 104);
  ctx.lineTo(x + 66, y - 60);
  ctx.closePath();
  ctx.fillStyle = "#b5533c";
  ctx.fill();
  ctx.fillStyle = "#9c452f";
  ctx.fillRect(x - 66, y - 64, 132, 6);
  ctx.fillStyle = "#8a6a45";
  ctx.fillRect(x - 10, y - 36, 20, 36);
  ctx.fillStyle = night ? "#ffd874" : "#9ed0dc";
  ctx.fillRect(x + 22, y - 44, 20, 18);
  ctx.fillRect(x - 42, y - 44, 20, 18);
  ctx.fillStyle = "#8f877c";
  ctx.fillRect(x + 28, y - 100, 14, 26);
  for (let i = 0; i < 4; i++) {
    const a = (t * 0.35 + i * 0.25) % 1;
    ellipse(ctx, x + 35 + Math.sin(a * 6 + i) * 6, y - 104 - a * 46, 6 + a * 8, 5 + a * 6, `rgba(255,255,255,${0.4 * (1 - a)})`);
  }
}

/// The notice board by the cottage: one paper note per notice, each with a
/// little picture of what is for sale.
function drawNoticeBoard(ctx, t, S) {
  const x = 975;
  const y = 506;
  ellipse(ctx, x, y + 2, 46, 7, "rgba(30,60,30,0.2)");
  ctx.fillStyle = "#6e5034";
  ctx.fillRect(x - 36, y - 74, 7, 76);
  ctx.fillRect(x + 29, y - 74, 7, 76);
  rr(ctx, x - 42, y - 90, 84, 56, 4);
  ctx.fillStyle = "#946a40";
  ctx.fill();
  rr(ctx, x - 38, y - 86, 76, 48, 3);
  ctx.fillStyle = "#c99d68";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 50, y - 88);
  ctx.lineTo(x, y - 106);
  ctx.lineTo(x + 50, y - 88);
  ctx.closePath();
  ctx.fillStyle = "#b5533c";
  ctx.fill();
  ctx.fillStyle = "#9c452f";
  ctx.fillRect(x - 50, y - 90, 100, 4);
  // Maren's wanted orders first, on yellow paper with a red band
  const wanted = (S.orders ?? []).slice(0, 3);
  const notes = [...wanted.map((o) => ({ ...o, wanted: true })), ...(S.board ?? [])].slice(0, 8);
  notes.forEach((n, i) => {
    const row = Math.floor(i / 4);
    const nx = x - 28 + (i % 4) * 18 + (row ? 4 : 0);
    const ny = y - 72 + row * 21;
    const sway = Math.sin(t * 1.3 + n.id) * 0.03;
    ctx.save();
    ctx.translate(nx, ny);
    ctx.rotate((((n.id * 37) % 9) - 4) * 0.035 + sway);
    ctx.fillStyle = "rgba(60,40,20,0.25)";
    ctx.fillRect(-6, -8, 14, 18);
    ctx.fillStyle = n.wanted ? "#f7e3a1" : "#fbf6e8";
    ctx.fillRect(-7, -9, 14, 18);
    if (n.wanted) {
      ctx.fillStyle = "#b5392b";
      ctx.fillRect(-7, -9, 14, 4);
    }
    const img = iconImage(n.token);
    if (img.complete) ctx.drawImage(img, -6, -5, 12, 12);
    ellipse(ctx, 0, -7, 1.7, 1.7, "#c0392b");
    ctx.restore();
  });
  if (!notes.length) {
    // a curling old notice, so the board does not look broken
    ctx.save();
    ctx.translate(x + 4, y - 63);
    ctx.rotate(0.12);
    ctx.fillStyle = "rgba(251,246,232,0.55)";
    ctx.fillRect(-9, -11, 18, 22);
    ctx.restore();
  }
}

function drawStall(ctx, t, S) {
  const x = 800;
  ellipse(ctx, x, 406, 86, 10, "rgba(30,60,30,0.22)");
  // back posts
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(x - 70, 300, 7, 100);
  ctx.fillRect(x + 63, 300, 7, 100);
  const shut = S.shut?.maren; // her purse ran dry: shutters down until someone invests
  if (shut) {
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = i % 2 ? "#8a6a45" : "#7a5c3a";
      ctx.fillRect(x - 70 + i * 20, 316, 20, 48);
    }
    ctx.strokeStyle = "rgba(50,32,15,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 66, 322);
    ctx.lineTo(x + 66, 358);
    ctx.stroke();
  } else drawMaren(ctx, x, 372, t, S);
  // counter
  ctx.fillStyle = "#a8794a";
  ctx.fillRect(x - 74, 364, 148, 38);
  ctx.fillStyle = "#c79a66";
  ctx.fillRect(x - 78, 358, 156, 10);
  ctx.strokeStyle = "rgba(70,45,20,0.3)";
  ctx.lineWidth = 1.5;
  for (let i = -50; i <= 50; i += 25) {
    ctx.beginPath();
    ctx.moveTo(x + i, 368);
    ctx.lineTo(x + i, 402);
    ctx.stroke();
  }
  // what is on the shelf right now
  const stock = S.market?.stock;
  if (stock && !shut) {
    let sx = x - 62;
    for (const token of ["pickaxe", "boat", "beacon", "rope", "ore", "pearl"]) {
      const n = Math.min(stock[token] ?? 0, 2);
      for (let i = 0; i < n && sx < x + 56; i++) {
        const img = iconImage(token);
        if (img.complete) ctx.drawImage(img, sx, 338, 22, 22);
        sx += 21;
      }
    }
  }
  // awning
  const stripes = 8;
  const w = 164 / stripes;
  for (let i = 0; i < stripes; i++) {
    const sx = x - 82 + i * w;
    ctx.fillStyle = i % 2 ? "#f6efe0" : "#c8523c";
    ctx.beginPath();
    ctx.moveTo(sx + 6, 284);
    ctx.lineTo(sx + w + 6, 284);
    ctx.lineTo(sx + w, 318);
    ctx.lineTo(sx, 318);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx + w / 2, 318, w / 2, 0, Math.PI);
    ctx.fill();
  }
  // lantern
  const glow = S.night ? 1 : 0.5;
  ctx.fillStyle = "#3a3a3a";
  ctx.fillRect(x + 71, 318, 2, 14);
  ellipse(ctx, x + 72, 338, 7, 8, `rgba(255,205,96,${shut ? 0.15 : glow})`);
  if (shut) handSign(ctx, x, 380, "CLOSED", "needs an investor", Math.sin(t * 1.2) * 0.03);
  else if (S.auction && S.auction.endsMs > Date.now()) {
    // her last lens is up for auction: a sign on a post beside the stall
    const left = Math.max(0, S.auction.endsMs - Date.now());
    const clock = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
    ctx.fillStyle = "#6b4a2b";
    ctx.fillRect(x + 119, 346, 5, 58);
    handSign(ctx, x + 121, 340, "AUCTION", S.auction.top ? `top bid ${Math.round(S.auction.top.unit)} · ${clock}` : `last lens · ${clock}`, Math.sin(t * 1.4) * 0.04);
  }
}

/// A player's shop on its pitch: a trestle table under a little canopy, the
/// owner's goods on it and the shop's name on a board. An empty pitch is a
/// chalked square with a "to let" stake.
const CLOTH = ["#3f7f8c", "#8c5a3f", "#5a7f3f", "#7f3f6a", "#3f5a8c", "#8c7f3f"];
function drawPitch(ctx, t, p, shop, goods) {
  const { x, y } = p;
  if (!shop) {
    ctx.strokeStyle = "rgba(255,255,255,0.32)";
    ctx.setLineDash([5, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 30, y - 18, 60, 26);
    ctx.setLineDash([]);
    ctx.fillStyle = "#7d5733";
    ctx.fillRect(x + 24, y - 30, 3, 24);
    rr(ctx, x + 10, y - 40, 32, 13, 2);
    ctx.fillStyle = "#f3e7c9";
    ctx.fill();
    ctx.fillStyle = "#94392a";
    ctx.font = "700 7px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("TO LET", x + 26, y - 31);
    return;
  }
  ellipse(ctx, x, y + 6, 40, 6, "rgba(30,60,30,0.22)");
  const cloth = CLOTH[shop.kind % CLOTH.length];
  // canopy poles and canopy
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(x - 34, y - 48, 3, 52);
  ctx.fillRect(x + 31, y - 48, 3, 52);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 ? "#f6efe0" : cloth;
    ctx.beginPath();
    ctx.moveTo(x - 38 + i * 12.7, y - 52);
    ctx.lineTo(x - 38 + (i + 1) * 12.7, y - 52);
    ctx.lineTo(x - 38 + (i + 1) * 12.7, y - 40);
    ctx.lineTo(x - 38 + i * 12.7, y - 40);
    ctx.closePath();
    ctx.fill();
  }
  // table and cloth
  ctx.fillStyle = "#946a40";
  ctx.fillRect(x - 30, y - 10, 60, 6);
  ctx.fillStyle = cloth;
  ctx.fillRect(x - 30, y - 6, 60, 10);
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(x - 27, y + 4, 3, 4);
  ctx.fillRect(x + 24, y + 4, 3, 4);
  // what is for sale
  goods.slice(0, 4).forEach((token, i) => {
    const img = iconImage(token);
    if (img.complete) ctx.drawImage(img, x - 26 + i * 13, y - 23, 14, 14);
  });
  // the shop's name
  ctx.font = "700 8px system-ui, sans-serif";
  const name = shop.mine ? "YOUR SHOP" : shop.name.toUpperCase();
  const w = Math.min(96, ctx.measureText(name).width + 12);
  rr(ctx, x - w / 2, y - 66, w, 13, 2);
  ctx.fillStyle = "#f3e7c9";
  ctx.fill();
  ctx.strokeStyle = "#7d5733";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#3b332b";
  ctx.textAlign = "center";
  ctx.fillText(name, x, y - 57, 90);
}

/// A hand-written sign hanging on a nail.
function handSign(ctx, x, y, big, small, tilt = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  rr(ctx, -46, -12, 92, 26, 3);
  ctx.fillStyle = "#f3e7c9";
  ctx.fill();
  ctx.strokeStyle = "#7d5733";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = "#94392a";
  ctx.textAlign = "center";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.fillText(big, 0, -1);
  ctx.fillStyle = "#3b332b";
  ctx.font = "8px system-ui, sans-serif";
  ctx.fillText(small, 0, 9);
  ctx.restore();
}

function drawMaren(ctx, x, y, t, S) {
  const bob = Math.sin(t * 1.8) * 1.2;
  const talking = S.shopOpen ? Math.sin(t * 9) * 1 : 0;
  // shawl and body
  rr(ctx, x - 17, y - 34 + bob, 34, 40, 12);
  ctx.fillStyle = "#2f7f86";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 17, y - 22 + bob);
  ctx.lineTo(x, y - 8 + bob);
  ctx.lineTo(x + 17, y - 22 + bob);
  ctx.lineTo(x + 17, y - 30 + bob);
  ctx.lineTo(x - 17, y - 30 + bob);
  ctx.closePath();
  ctx.fillStyle = "#e3b24f";
  ctx.fill();
  // head, bun, face
  ellipse(ctx, x, y - 58 + bob, 9, 8, "#d8d8d2");
  ellipse(ctx, x, y - 44 + bob, 13, 13, "#e9bf9b");
  ctx.beginPath();
  ctx.arc(x, y - 47 + bob, 13.5, Math.PI * 1.02, Math.PI * 1.98);
  ctx.fillStyle = "#d8d8d2";
  ctx.fill();
  ellipse(ctx, x - 4.5, y - 44 + bob, 1.5, 1.8, "#3b2f2a");
  ellipse(ctx, x + 4.5, y - 44 + bob, 1.5, 1.8, "#3b2f2a");
  ctx.strokeStyle = "#8a4c3a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y - 40 + bob, 4, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  if (talking) ellipse(ctx, x, y - 37 + bob, 2.4, 1.2 + Math.abs(talking), "#8a4c3a");
}

// ---------- Silas, the pearl and ore dealer, on the beach below the lighthouse ----------
function drawDealerBoat(ctx, t, storm) {
  const bob = Math.sin(t * (storm ? 2.6 : 1.3)) * (storm ? 4 : 1.5);
  const tilt = Math.sin(t * (storm ? 2.1 : 1)) * (storm ? 0.12 : 0.04);
  // the mooring line to a post on the sand
  ellipse(ctx, 449, 334, 4, 2.5, "rgba(40,40,30,0.3)");
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(446, 316, 6, 18);
  ctx.strokeStyle = "#cdbb93";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(449, 320);
  ctx.quadraticCurveTo(432, 330 + bob, 418, 322 + bob);
  ctx.stroke();
  if (!storm) return drawBoat(ctx, 386, 326 + bob, tilt);
  // battened down: no sail, a tarp over the hull
  ctx.save();
  ctx.translate(386, 326 + bob);
  ctx.rotate(tilt);
  ctx.beginPath();
  ctx.moveTo(-38, -4);
  ctx.lineTo(38, -4);
  ctx.lineTo(28, 10);
  ctx.lineTo(-28, 10);
  ctx.closePath();
  ctx.fillStyle = "#9a6b3f";
  ctx.fill();
  rr(ctx, -34, -12, 68, 9, 4);
  ctx.fillStyle = "#5f6b52";
  ctx.fill();
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(-2, -34, 3, 24);
  ctx.restore();
}

function drawDealerPitch(ctx, t, S) {
  const storm = S.storm?.active;
  // crates of goods bound for the city
  for (const [x, y, w, h] of [[496, 290, 18, 15], [512, 293, 16, 13], [502, 278, 15, 13]]) {
    ctx.fillStyle = "#a77a4a";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#7d5733";
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
  }
  // his sign
  ctx.fillStyle = "#6b4a2b";
  ctx.fillRect(531, 262, 3, 44);
  rr(ctx, 491, 244, 84, 24, 4);
  ctx.fillStyle = "#f3e7c9";
  ctx.fill();
  ctx.strokeStyle = "#7d5733";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = "#3d4a6b";
  ctx.textAlign = "center";
  ctx.font = "700 9px system-ui, sans-serif";
  const away = S.shut?.silas; // his purse ran dry: gone to the city to raise money
  ctx.fillText(away ? "GONE TO CITY" : storm ? "BACK AFTER" : "SILAS", 533, 254);
  ctx.font = "8px system-ui, sans-serif";
  ctx.fillText(away ? "needs a backer" : storm ? "the storm" : "buys ore & pearls", 533, 264);
  if (!storm && !away) drawSilas(ctx, 476, 314, t, S);
}

function drawSilas(ctx, x, y, t, S) {
  const bob = Math.sin(t * 1.6 + 1) * 1;
  const talking = S.shopOpen && S.shopWho === "silas" ? Math.sin(t * 9) * 1 : 0;
  ellipse(ctx, x, y + 1, 14, 4, "rgba(30,40,30,0.25)");
  ctx.fillStyle = "#2b2f3a";
  ctx.fillRect(x - 7, y - 12, 5, 13);
  ctx.fillRect(x + 2, y - 12, 5, 13);
  // a long city coat
  ctx.beginPath();
  ctx.moveTo(x - 13, y - 8 + bob);
  ctx.lineTo(x - 10, y - 40 + bob);
  ctx.lineTo(x + 10, y - 40 + bob);
  ctx.lineTo(x + 13, y - 8 + bob);
  ctx.closePath();
  ctx.fillStyle = "#3d4a6b";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 6, y - 40 + bob);
  ctx.lineTo(x, y - 29 + bob);
  ctx.lineTo(x + 6, y - 40 + bob);
  ctx.closePath();
  ctx.fillStyle = "#b8432f";
  ctx.fill();
  ellipse(ctx, x, y - 24 + bob, 1.4, 1.4, "#e3b24f");
  ellipse(ctx, x, y - 17 + bob, 1.4, 1.4, "#e3b24f");
  rr(ctx, x + 9, y - 27 + bob, 9, 11, 2); // satchel
  ctx.fillStyle = "#8a5a32";
  ctx.fill();
  // head, beard, eyes
  ellipse(ctx, x, y - 50 + bob, 10, 10, "#d9a77f");
  ctx.beginPath();
  ctx.arc(x, y - 48 + bob, 9.5, 0.12 * Math.PI, 0.88 * Math.PI);
  ctx.fillStyle = "#4a3426";
  ctx.fill();
  ellipse(ctx, x - 3.5, y - 52 + bob, 1.3, 1.5, "#2a211c");
  ellipse(ctx, x + 3.5, y - 52 + bob, 1.3, 1.5, "#2a211c");
  if (talking) ellipse(ctx, x, y - 44 + bob, 2.2, 1 + Math.abs(talking), "#2a211c");
  // a tall hat
  ctx.fillStyle = "#23262e";
  ctx.fillRect(x - 13, y - 61 + bob, 26, 3);
  rr(ctx, x - 8, y - 77 + bob, 16, 17, 2);
  ctx.fill();
  ctx.fillStyle = "#b8432f";
  ctx.fillRect(x - 8, y - 64 + bob, 16, 3);
}

function drawLighthouse(ctx, t, lit) {
  const x = 386;
  const base = 148;
  ellipse(ctx, x, base + 2, 50, 14, "#8f877c");
  ellipse(ctx, x - 8, base - 2, 36, 9, "#a79f93");
  // tower
  ctx.beginPath();
  ctx.moveTo(x - 22, base);
  ctx.lineTo(x - 13, base - 96);
  ctx.lineTo(x + 13, base - 96);
  ctx.lineTo(x + 22, base);
  ctx.closePath();
  ctx.fillStyle = "#f6f1e4";
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#c8523c";
  ctx.fillRect(x - 30, base - 76, 60, 18);
  ctx.fillRect(x - 30, base - 38, 60, 18);
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.fillRect(x + 4, base - 100, 30, 100);
  ctx.restore();
  ctx.fillStyle = "#5c4630";
  rr(ctx, x - 6, base - 18, 12, 18, 6);
  ctx.fill();
  // gallery and lamp room
  ctx.fillStyle = "#3f3b36";
  ctx.fillRect(x - 19, base - 101, 38, 6);
  ctx.fillStyle = lit ? "#ffe07a" : "#77858c";
  ctx.fillRect(x - 10, base - 122, 20, 21);
  ctx.strokeStyle = "#3f3b36";
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 10, base - 122, 20, 21);
  ctx.beginPath();
  ctx.moveTo(x, base - 122);
  ctx.lineTo(x, base - 101);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 14, base - 122);
  ctx.lineTo(x, base - 138);
  ctx.lineTo(x + 14, base - 122);
  ctx.closePath();
  ctx.fillStyle = "#c8523c";
  ctx.fill();
}

function drawPlayer(ctx, p, t) {
  const { x, y } = p;
  const moving = p.moving;
  const step = moving ? Math.sin(t * 13) : 0;
  const dig = p.digging ? Math.sin(t * 11) : 0;
  const bob = moving ? Math.abs(step) * 2 : p.digging ? Math.abs(dig) * 3 : Math.sin(t * 2) * 0.6;
  ellipse(ctx, x, y + 1, 14, 5, "rgba(20,40,20,0.25)");
  // legs
  ctx.fillStyle = "#4a3c32";
  ctx.fillRect(x - 6, y - 10 + Math.max(0, step) * 3, 5, 10 - Math.max(0, step) * 3);
  ctx.fillRect(x + 1, y - 10 + Math.max(0, -step) * 3, 5, 10 - Math.max(0, -step) * 3);
  // sack on the back when carrying goods
  if (p.carrying) ellipse(ctx, x - p.face * 10, y - 22 - bob, 8, 9, "#c9b07a");
  // tunic
  rr(ctx, x - 10, y - 32 - bob, 20, 24, 7);
  ctx.fillStyle = "#e07a3f";
  ctx.fill();
  ctx.fillStyle = "#c7652e";
  ctx.fillRect(x - 10, y - 18 - bob, 20, 3);
  // arm / tool swing
  if (p.digging) {
    ctx.save();
    ctx.translate(x + p.face * 8, y - 24 - bob);
    ctx.rotate(p.face * (0.4 + dig * 0.9));
    ctx.fillStyle = "#9a6b3f";
    ctx.fillRect(-1.5, -20, 3, 22);
    if (p.tool === "pickaxe") {
      ctx.fillStyle = "#8f96a3";
      ctx.beginPath();
      ctx.moveTo(-10, -18);
      ctx.quadraticCurveTo(0, -26, 10, -18);
      ctx.lineTo(8, -15);
      ctx.quadraticCurveTo(0, -21, -8, -15);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = "#c9a56a";
      ctx.fillRect(-5, -24, 10, 6);
    }
    ctx.restore();
  }
  // head and straw hat
  ellipse(ctx, x, y - 40 - bob, 9, 9, "#f0c9a4");
  ellipse(ctx, x + p.face * 3.5, y - 40 - bob, 1.4, 1.7, "#3b2f2a");
  ellipse(ctx, x, y - 46 - bob, 15, 4.5, "#e6c36a");
  ctx.beginPath();
  ctx.ellipse(x, y - 47 - bob, 8.5, 7, 0, Math.PI, 0);
  ctx.fillStyle = "#edd085";
  ctx.fill();
  ctx.fillStyle = "#c8523c";
  ctx.fillRect(x - 8.5, y - 49 - bob, 17, 2.4);
}

function drawGulls(ctx, t) {
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    const a = t * (0.22 + i * 0.05) + i * 2.1;
    const x = 250 + Math.cos(a) * (160 + i * 40) + i * 60;
    const y = 300 + Math.sin(a * 1.3) * (120 + i * 30);
    const flap = Math.sin(t * 6 + i) * 4;
    ctx.beginPath();
    ctx.moveTo(x - 9, y - flap);
    ctx.quadraticCurveTo(x - 4, y - 4, x, y);
    ctx.quadraticCurveTo(x + 4, y - 4, x + 9, y - flap);
    ctx.stroke();
  }
}

function drawNight(ctx, t, amount) {
  if (amount <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgba(48,58,120,${0.72 * amount})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  // the beam
  const lx = 386;
  const ly = 36;
  for (const dir of [0, Math.PI]) {
    const a = t * 0.7 + dir;
    const g = ctx.createRadialGradient(lx, ly, 6, lx, ly, 760);
    g.addColorStop(0, `rgba(255,236,160,${0.55 * amount})`);
    g.addColorStop(1, "rgba(255,236,160,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.arc(lx, ly, 760, a - 0.16, a + 0.16);
    ctx.closePath();
    ctx.fill();
  }
  const glow = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,224,130,${a * amount})`);
    g.addColorStop(1, "rgba(255,224,130,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  glow(lx, ly, 90, 0.9);
  glow(872, 338, 80, 0.6);
  glow(1082, 560, 90, 0.35);
  ctx.restore();
}

function pill(ctx, x, y, text, sub) {
  ctx.font = "600 15px system-ui, sans-serif";
  const w1 = ctx.measureText(text).width;
  ctx.font = "13px system-ui, sans-serif";
  const w2 = sub ? ctx.measureText(sub).width + 10 : 0;
  const w = w1 + w2 + 50;
  const left = Math.max(8, Math.min(W - w - 8, x - w / 2));
  rr(ctx, left, y - 15, w, 30, 15);
  ctx.fillStyle = "rgba(38,34,30,0.86)";
  ctx.fill();
  rr(ctx, left + 5, y - 10, 22, 20, 5);
  ctx.fillStyle = "#f6ecd4";
  ctx.fill();
  ctx.fillStyle = "#2c2a26";
  ctx.font = "700 13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText("E", left + 16, y + 1);
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.fillText(text, left + 34, y + 1);
  if (sub) {
    ctx.fillStyle = "#f6cf6b";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText(sub, left + 34 + w1 + 10, y + 1);
  }
}

/// Draw one frame. `S` is the game state (see game.js).
export function drawWorld(ctx, t, S) {
  ctx.clearRect(0, 0, W, H);
  const lvl = S.tide?.height ?? 0; // -1 low water .. 1 high water (spring tides go further)
  const wx = -8 + 14 * lvl; // where the water's edge sits, from the shoreline
  const rough = S.storm?.level ?? 0;
  const event = S.event?.active ? S.event.kind : null;
  drawSea(ctx, t, wx, rough);
  if (event === "red_tide") tintSea(ctx, "rgba(196,48,36,0.7)", "color");
  if (event === "calm") {
    tintSea(ctx, "rgba(255,255,255,0.14)");
    drawGlints(ctx, t);
  }
  drawReef(ctx, t, lvl);
  drawLand(ctx, t, wx);
  drawWashedUp(ctx, lvl);
  if (event === "shipwreck") drawWreck(ctx, t);
  drawCliffs(ctx, t);
  drawPier(ctx, t, S.hasBoat && !S.atSea);
  if (S.dealer) drawDealerBoat(ctx, t, S.storm?.active);
  drawTidePools(ctx, t, lvl);

  // spots you can use, with a soft ring
  for (const h of HOTSPOTS) {
    if (!present(h, S)) continue;
    const near = S.near === h.id;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3);
    ctx.strokeStyle = `rgba(255,255,255,${near ? 0.75 : 0.22 + 0.12 * pulse})`;
    ctx.lineWidth = near ? 3 : 2;
    ctx.setLineDash([7, 7]);
    ctx.lineDashOffset = -t * 12;
    ctx.beginPath();
    ctx.ellipse(h.x, h.y, 26 + (near ? pulse * 3 : 0), 12 + (near ? pulse * 1.5 : 0), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // things that stand up, back to front
  const things = [
    { y: 150, draw: () => drawLighthouse(ctx, t, S.night) },
    { y: 404, draw: () => drawStall(ctx, t, S) },
    { y: 601, draw: () => drawCottage(ctx, t, S.night) },
    { y: 506, draw: () => drawNoticeBoard(ctx, t, S) },
    { y: 566, draw: () => drawWorkbench(ctx, t) },
    ...(S.dealer ? [{ y: 314, draw: () => drawDealerPitch(ctx, t, S) }] : []),
    ...PITCHES.map((p, i) => ({ y: p.y, draw: () => drawPitch(ctx, t, p, S.pitchShops?.[i], S.pitchGoods?.[i] ?? []) })),
    ...TREES.map(([x, y, s]) => ({ y, draw: () => drawTree(ctx, x, y, s, t) })),
  ];
  if (!S.atSea) things.push({ y: S.player.y, draw: () => drawPlayer(ctx, S.player, t) });
  things.sort((a, b) => a.y - b.y);
  for (const thing of things) thing.draw();

  // rowing out to the reef and back
  if (S.atSea) {
    const k = S.atSea; // 0..1 along the trip
    const bx = 212 - 60 * Math.sin(k * Math.PI);
    const by = 592 - 70 * Math.sin(k * Math.PI);
    drawBoat(ctx, bx, by + Math.sin(t * 3) * 2, Math.sin(t * 2.2) * 0.07);
    ellipse(ctx, bx - 4, by - 14, 7, 7, "#f0c9a4");
    ellipse(ctx, bx - 4, by - 19, 11, 3.5, "#e6c36a");
  }

  if (event === "festival") drawBunting(ctx, t, S.night);
  if (event === "fog") drawFog(ctx, t);
  drawStorm(ctx, t, rough);
  if (rough < 0.4) drawGulls(ctx, t); // the gulls shelter from the storm
  drawNight(ctx, t, S.nightAmount);

  // things floating up: "+2 kelp"
  ctx.textBaseline = "middle";
  for (const f of S.floats) {
    if (f.wait > 0) continue;
    const a = Math.min(1, (f.life / f.total) * 2.2);
    const y = f.y - (1 - f.life / f.total) * 46;
    ctx.globalAlpha = a;
    ctx.font = "700 17px system-ui, sans-serif";
    const tw = ctx.measureText(f.text).width;
    const w = tw + (f.icon ? 40 : 20);
    rr(ctx, f.x - w / 2, y - 14, w, 28, 14);
    ctx.fillStyle = f.bad ? "rgba(140,40,30,0.9)" : "rgba(38,34,30,0.86)";
    ctx.fill();
    let tx = f.x - w / 2 + 10;
    if (f.icon) {
      const img = iconImage(f.icon);
      if (img.complete) ctx.drawImage(img, tx, y - 10, 20, 20);
      tx += 24;
    }
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(f.text, tx, y + 1);
    ctx.globalAlpha = 1;
  }

  // what the player is doing, or what they could do here
  if (S.busyText) {
    const dots = ".".repeat(1 + (Math.floor(t * 3) % 3));
    ctx.font = "600 15px system-ui, sans-serif";
    const px = S.atSea ? 170 : S.player.x;
    const py = (S.atSea ? 500 : S.player.y) - 74;
    const w = ctx.measureText(S.busyText + "...").width + 24;
    rr(ctx, px - w / 2, py - 14, w, 28, 14);
    ctx.fillStyle = "rgba(38,34,30,0.86)";
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(S.busyText + dots, px - w / 2 + 12, py + 1);
  } else if (S.near && !S.shopOpen && !S.boardOpen && !S.benchOpen && !S.pitchOpen) {
    const h = HOTSPOTS.find((s) => s.id === S.near);
    let sub = h.cost ? `${h.cost} energy` : "";
    const outdoors = h.id === "shore" || h.id === "reef" || h.id === "cliffs";
    const weather = !outdoors ? "" : S.storm?.active ? STORM_TEXT[h.id] : h.id !== "cliffs" && S.tide ? TIDE_TEXT[S.tide.phase][h.id] : "";
    if (weather) sub += ` · ${weather}`;
    let verb = h.verb;
    if (h.pitch !== undefined) {
      const shop = S.pitchShops?.[h.pitch];
      verb = shop ? `Visit ${shop.mine ? "your shop" : shop.name}` : "Rent this pitch";
      sub = shop ? (shop.mine ? "" : "kept by the clerk") : `${S.pitchRent ?? 40} coins a day`;
    }
    pill(ctx, h.x, h.y - (h.pillUp ?? 62), verb, sub);
  }
}
