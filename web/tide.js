// The tide, worked out from the clock exactly as the contract does it
// (`tide_at` in contract/src/lib.rs). Shared by the browser and the server.
//
// One full tide every 10 minutes, in four equal parts: low, rising, high,
// falling. Every third tide is a spring tide: lower lows, higher highs.

export const TIDE_PERIOD_MS = 10 * 60 * 1000;
export const PHASES = ["low", "rising", "high", "falling"];
export const SPRING_EVERY = 3;
const QUARTER = TIDE_PERIOD_MS / 4;

/// The tide at `ms` (Unix time): { phase, spring, endsMs, height }.
export function tideAt(ms) {
  const cycle = Math.floor(ms / TIDE_PERIOD_MS);
  const index = Math.floor((ms - cycle * TIDE_PERIOD_MS) / QUARTER);
  return {
    phase: PHASES[index],
    spring: cycle % SPRING_EVERY === 0,
    endsMs: cycle * TIDE_PERIOD_MS + (index + 1) * QUARTER,
    height: tideHeight(ms),
  };
}

/// The next time the tide is `phase` (and, if asked, a spring tide), at or after `ms`.
export function nextTide(ms, phase, spring = false) {
  const index = PHASES.indexOf(phase);
  let cycle = Math.floor(ms / TIDE_PERIOD_MS);
  for (;; cycle++) {
    const start = cycle * TIDE_PERIOD_MS + index * QUARTER;
    if (start + QUARTER <= ms) continue;
    if (spring && cycle % SPRING_EVERY !== 0) continue;
    return start;
  }
}

/// How high the water stands, about -1 (lowest) to 1 (highest), smoothly.
/// Lowest in the middle of "low", highest in the middle of "high"; spring
/// tides swing about a third further.
export function tideHeight(ms) {
  const p = (ms % TIDE_PERIOD_MS) / TIDE_PERIOD_MS;
  // distance to the middle of the nearest spring low, for a smooth swell
  const span = TIDE_PERIOD_MS * SPRING_EVERY;
  const springMid = TIDE_PERIOD_MS / 8;
  let d = Math.abs(((ms - springMid) % span + span) % span);
  d = Math.min(d, span - d);
  const swell = d < TIDE_PERIOD_MS ? 0.5 + 0.5 * Math.cos((Math.PI * d) / TIDE_PERIOD_MS) : 0;
  return -Math.cos(2 * Math.PI * (p - 0.125)) * (1 + 0.35 * swell);
}

/// What the tide does to Maren's offers: what it brings in by the armful is
/// cheap, what it hides is dear. (Ore comes from the cliffs, above the tide.)
const BID = {
  low: { kelp: 0.8, pearl: 0.85, driftwood: 1.2 },
  high: { kelp: 1.2, pearl: 1.15, driftwood: 0.8 },
};
export function tideBidFactor(token, tide) {
  const f = tide && BID[tide.phase]?.[token];
  if (!f) return 1;
  return tide.spring ? 1 + (f - 1) * 1.4 : f;
}

/// Words for the tide, for the HUD and the shopkeeper.
export const TIDE_TEXT = {
  low: {
    name: "Low tide",
    what: "Rock pools full of kelp · reef shallow, pearls easy",
    shore: "pools full of kelp",
    reef: "reef shallow",
    price: "Maren pays less for kelp and pearls, more for driftwood",
  },
  rising: { name: "Tide rising", what: "High tide next: driftwood washes up, the pools and reef go under", shore: "", reef: "", price: "Maren's prices are ordinary" },
  high: {
    name: "High tide",
    what: "Driftwood washing up · pools and reef under water",
    shore: "driftwood washing up",
    reef: "reef deep",
    price: "Maren pays more for kelp and pearls, less for driftwood",
  },
  falling: { name: "Tide going out", what: "Low tide next: rock pools full of kelp, pearls easy", shore: "", reef: "", price: "Maren's prices are ordinary" },
};
export const tideName = (tide) => (tide.spring && (tide.phase === "low" || tide.phase === "high") ? `Spring ${tide.phase} tide` : TIDE_TEXT[tide.phase].name);
