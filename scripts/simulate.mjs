#!/usr/bin/env node
// The fast-forward without a browser: simulates days of Tidewater trading with
// the live merchants' own pricing rules (web/merchant.js) and a copy of the
// contract's rules (web/sim-engine.js), and prints what happened. No transactions.
//
//   node scripts/simulate.mjs                      a week, 8 players, from a fresh market
//   node scripts/simulate.mjs --days 3 --players 12 --seed 4 --mainland 12000
//   node scripts/simulate.mjs --flood 24           dump 150 ore on the market after 24 hours
//   node scripts/simulate.mjs --csv > week.csv     the price samples, one row every ten minutes
import { createSim, runFor, summary, inject, DAY_MS } from "../web/sim-engine.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : Number(args[i + 1]);
};
const days = opt("days", 7);
const sim = createSim({ seed: opt("seed", 1), players: opt("players", 8), mainlandPerDay: opt("mainland", 6000) });
const flood = opt("flood", -1);
if (flood >= 0) {
  runFor(sim, flood * 3600_000);
  inject(sim, "flood");
}
runFor(sim, days * DAY_MS - (sim.t - sim.start));

if (args.includes("--csv")) {
  const cols = ["kelp", "driftwood", "ore", "pearl", "pickaxe", "boat", "beacon"];
  console.log(["hours", ...cols, "silas_ore", "silas_pearl", "maren_purse", "silas_purse", "mainland", "players_pockets", "storm", "maren_shut"].join(","));
  for (const s of sim.history) {
    console.log([((s.t - sim.start) / 3600_000).toFixed(2), ...cols.map((c) => s.prices[c]), s.silas.ore ?? "", s.silas.pearl ?? "", s.maren, s.silasPurse, s.mainland, s.pockets, s.storm ? 1 : 0, s.closed.maren ? 1 : 0].join(","));
  }
} else {
  const s = summary(sim);
  const r = ([a, b]) => `${a} – ${b}`;
  console.log(`Tidewater fast-forward: ${days} days, ${sim.players.filter((p) => !p.id.startsWith("flood")).length} players, seed ${sim.seed} (a simulation: no transactions)\n`);
  console.log("What Maren paid (low – high):  " + ["kelp", "driftwood", "ore", "pearl"].map((t) => `${t} ${r(s.prices[t])}`).join(", "));
  console.log("What she asked:                " + ["pickaxe", "boat", "beacon"].map((t) => `${t} ${r(s.prices[t])}`).join(", "));
  console.log("What Silas paid:               " + Object.entries(s.silas).map(([t, v]) => `${t} ${r(v)}`).join(", "));
  console.log(`\nTrips ${s.forages}, deals at the counters ${s.trades}, board sales ${s.boardSales}, orders filled ${s.ordersFilled}, crafted ${s.crafted}, exports ${s.exports}, pickaxes broken ${s.pickaxesBroken}, lighthouses lit ${s.beacons}`);
  console.log(`Shut: Maren ${s.closures.maren}, Silas ${s.closures.silas}; invested ${s.invested}, repaid ${s.repaid}`);
  console.log(`Coins at the end: Maren ${s.money.maren}, Silas ${s.money.silas}, the mainland's purse ${s.money.mainland}, players ${s.money.pockets}`);
  console.log("\nWhat happened:");
  for (const e of sim.story.filter((x) => x.kind !== "order").slice(0, 25)) console.log(`  ${((e.t - sim.start) / 3600_000).toFixed(1).padStart(6)}h  ${e.text}`);
}
