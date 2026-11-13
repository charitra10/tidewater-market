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

// ---------------------------------------------------------------------------
// Storms: exactly one in every 30 minutes (each run of three tides, starting
// with a spring tide), 4 minutes long, at a time picked by a public hash of
// that half hour. Anyone can forecast them. Same formula as `storm_at` in the
// contract.
// ---------------------------------------------------------------------------
export const STORM_BLOCK_MS = 30 * 60 * 1000;
export const STORM_MS = 4 * 60 * 1000;
const STORM_SLOT_MS = 2 * 60 * 1000;
const STORM_SLOTS = 13; // a storm starts 0, 2, 4 ... 24 minutes into its half hour

/// A 32-bit integer hash (the contract does the same with wrapping u32 maths).
export function mix32(x) {
  let h = (x ^ 0x9e3779b9) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
function stormIn(block) {
  const startMs = block * STORM_BLOCK_MS + (mix32(block) % STORM_SLOTS) * STORM_SLOT_MS;
  return { startMs, endsMs: startMs + STORM_MS };
}

/// The storm blowing at `ms`, or else the next one: { active, startMs, endsMs }.
/// A calm (see `eventAt`) calls off the storm due in it.
export function stormAt(ms) {
  let block = Math.floor(ms / STORM_BLOCK_MS);
  for (;;) {
    const s = stormIn(block);
    if (stormCalledOff(block) || ms >= s.endsMs) {
      block++;
      continue;
    }
    return { active: ms >= s.startMs, ...s };
  }
}

/// How hard it is blowing, 0..1: it builds over the minute before a storm and
/// dies away over the minute after (only for drawing; the rules use `stormAt`).
export function stormLevel(ms) {
  const ramp = 60_000;
  const block = Math.floor(ms / STORM_BLOCK_MS);
  let level = 0;
  for (const b of [block - 1, block, block + 1]) {
    if (stormCalledOff(b)) continue;
    const s = stormIn(b);
    level = Math.max(level, Math.min(1, (ms - (s.startMs - ramp)) / ramp, (s.endsMs + ramp - ms) / ramp));
  }
  return level;
}

/// A storm is a supply shock: no pearls can come in from the reef, and the
/// shore is covered in driftwood.
const STORM_BID = { pearl: 1.25, driftwood: 0.75 };
export function stormBidFactor(token, storm) {
  return storm?.active ? (STORM_BID[token] ?? 1) : 1;
}

export const STORM_TEXT = {
  name: "Storm",
  what: "Reef too rough to row to · the shore is covered in wrack",
  price: "Maren pays more for pearls, less for driftwood. No boat to the mainland",
  shore: "storm wrack: driftwood, maybe a pearl",
  reef: "too rough to row out",
  cliffs: "slippery: pickaxes break more",
};

// ---------------------------------------------------------------------------
// Events: one every hour, lasting one whole tide (10 minutes), picked by a
// public hash of the hour, so they can be forecast. Same formula as `event_at`
// in the contract.
//   fog        the reef is a gamble: nothing at all, or a haul of pearls
//   red_tide   the kelp turns: nobody finds any worth keeping, and Maren won't buy it
//   shipwreck  cargo washes up on the shore: rope, ore, now and then a whole boat
//   festival   the village wants beacon lenses: Maren asks more for them, and pays more for pearls
//   calm       a flat sea: an extra pearl on the reef, and the storm due in it never comes
// ---------------------------------------------------------------------------
export const EVENT_BLOCK_MS = 60 * 60 * 1000;
export const EVENTS = ["fog", "red_tide", "shipwreck", "festival", "calm"];
const EVENT_SALT = 0x5eed7e1d;

const eventKind = (hour) => EVENTS[mix32((hour ^ EVENT_SALT) >>> 0) % EVENTS.length];
function eventIn(hour) {
  const kind = eventKind(hour);
  let startMs;
  if (kind === "calm") {
    // a calm settles over the tide in which the hour's first storm was due
    const storm = stormIn(hour * 2).startMs;
    startMs = storm - (storm % TIDE_PERIOD_MS);
  } else {
    startMs = hour * EVENT_BLOCK_MS + ((mix32((hour ^ EVENT_SALT) >>> 0) >>> 8) % 6) * TIDE_PERIOD_MS;
  }
  return { kind, startMs, endsMs: startMs + TIDE_PERIOD_MS };
}
/// Is the storm of half hour `block` called off by a calm?
function stormCalledOff(block) {
  return block % 2 === 0 && eventKind(block / 2) === "calm";
}
/// The event under way at `ms`, or else the next one: { kind, active, startMs, endsMs }.
export function eventAt(ms) {
  const hour = Math.floor(ms / EVENT_BLOCK_MS);
  let e = eventIn(hour);
  if (ms >= e.endsMs) e = eventIn(hour + 1);
  return { ...e, active: ms >= e.startMs && ms < e.endsMs };
}

/// What an event does to Maren's prices. A factor of 0 means she won't buy it at all.
const EVENT_BID = { red_tide: { kelp: 0 }, festival: { pearl: 1.1 } };
const EVENT_ASK = { festival: { beacon: 1.25 } };
export function eventBidFactor(token, event) {
  return event?.active ? (EVENT_BID[event.kind]?.[token] ?? 1) : 1;
}
export function eventAskFactor(token, event) {
  return event?.active ? (EVENT_ASK[event.kind]?.[token] ?? 1) : 1;
}

/// Words for each event, for the tide card, the news and the merchants' reasons.
export const EVENT_TEXT = {
  fog: {
    name: "Fog",
    what: "Thick fog on the water: the reef is a gamble, nothing or a haul of pearls",
    start: "Fog rolls in off the sea. Row out to the reef and you might find nothing at all, or more pearls than you can carry.",
    soon: "Fog is coming",
  },
  red_tide: {
    name: "Red tide",
    what: "The kelp has turned: none worth keeping, and Maren won't buy any",
    start: "A red tide! The kelp has turned, and nobody will touch it until the water clears. Sell your kelp before it comes, next time.",
    soon: "A red tide is coming: sell your kelp first",
    why: "Red tide: she won't touch kelp until the water clears",
  },
  shipwreck: {
    name: "Shipwreck",
    what: "A wreck's cargo along the tideline: rope, ore, maybe a whole boat",
    start: "A ship has gone down off the point! Cargo is washing up on the shore: rope, ore, maybe even a boat.",
    soon: "Wreckage is drifting in",
  },
  festival: {
    name: "Festival",
    what: "Lantern festival: everyone wants a beacon lens. Maren asks more, and pays more for pearls",
    start: "It's the lantern festival! The whole village wants a beacon lens, so Maren asks more for hers and pays more for pearls.",
    soon: "The lantern festival is coming",
    why: { beacon: "Lantern festival: everyone wants a beacon lens", pearl: "Lantern festival: she needs pearls for lenses" },
  },
  calm: {
    name: "Calm",
    what: "A flat calm: an extra pearl on the reef, and no storm",
    start: "The sea has gone flat calm. The reef is clear to the bottom, and the storm that was due won't come.",
    soon: "A calm is coming: no storm this hour",
  },
};
