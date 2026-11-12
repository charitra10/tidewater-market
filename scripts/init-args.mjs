// Prints the JSON arguments for the contract's `new` call.
// usage: node scripts/init-args.mjs <owner> <merchant>
const [owner, merchant] = process.argv.slice(2);
// 1 coin = 0.001 NEAR. Prices per single item, in coins.
const yocto = (coins) => (BigInt(Math.round(coins * 10)) * 10n ** 20n).toString();
//                 kelp driftwood ore pearl rope pickaxe boat beacon
const floor =     [2,   3,   15,  40,  12,  35,  140, 350]; // Maren may not sell below this
const ceiling =   [6,   9,   42,  110, 24,  60,  240, 600]; // ... or pay more than this
const exportPx =  [2.8, 4.2, 21,  56,  0,   0,   0,   0];   // what the mainland pays
console.log(JSON.stringify({
  owner_id: owner,
  merchant_id: merchant,
  policy: {
    floor: floor.map(yocto),
    ceiling: ceiling.map(yocto),
    buy_window_limit: yocto(1500), // most she may spend buying per window
    window_sec: 600,
    max_quote_ttl_sec: 300,
    export_price: exportPx.map(yocto),
  },
  energy_max: 12,
  energy_regen_sec: Number(process.env.ENERGY_REGEN_SEC || 6),
}));
