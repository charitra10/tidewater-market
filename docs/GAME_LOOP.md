# The game loop

What a player does every 30 seconds, every 5 minutes, every half hour and every session, with the real numbers from the code.

This is the design as it stands in the game today. It was written up after the code, not before it. The numbers come from the code, and the files and functions that set them are linked as they come up. Things that are planned but not built yet are listed separately at the end.

## At a glance

| Timescale | What you do | What drives it |
|---|---|---|
| **30 seconds** | One or two trips: forage, walk to a buyer, sell or haggle. Sell now, or hold? | Energy: 12 at most, 1 back every 6 s |
| **5 minutes** | Half a tide. Gather while the water is low, sell while it is high. Choose Maren or Silas, check the notice board. | The tide: 10 minutes, four parts of 2½ minutes, every third tide a spring tide |
| **30 minutes** | One storm, forecast in advance. Hold pearls back before it, comb the wrack during it. | The storm clock: one 4-minute storm per half hour, at a time anyone can work out |
| **Session** | Pickaxe, then the cliffs. Boat, then the reef. Beacon lens, then the lighthouse and the keepers' board. | Prices that move with the merchants' stock and money |

## Every 30 seconds: one trip

Energy is the clock at this scale. You have up to 12 points and get one back every 6 seconds ([`init-args.mjs`](../scripts/init-args.mjs)), so about **5 points come back every 30 seconds**. That is five trips to the shore, two to the cliffs, or one to the reef with some to spare.

| Spot | Energy | Needs | You find (calm weather) | Maren pays, on an everyday shelf |
|---|---|---|---|---|
| Shore | 1 | nothing | 1–5 kelp and 0–4 driftwood, depending on the tide | about 9 coins per energy point |
| Cliffs | 2 | a pickaxe, which breaks 12% of the time | 1–2 ore, 0–1 driftwood | about 15 per point, or 11 after the pickaxes you will break |
| Reef | 3 | a boat | 0–3 pearls, depending on the tide, and 1–2 kelp | about 18 per point, and up to 30 if you gather at low water and sell at high |

The yields are the `forage` function in [`contract/src/lib.rs`](../contract/src/lib.rs). The prices are Maren's bids at her target stock with a comfortable treasury ([`unitBid`](../server/merchant.js)); they fall as her shelf fills, and rise when she runs short.

Then you walk to a buyer and decide:

- **Maren** at the stall buys all four raw goods (kelp, driftwood, ore, pearls).
- **Silas** on the beach buys only ore and pearls, and his offer is shown next to hers.
- **The notice board** by the cottage: pin your goods at your own price and wait for another player, or buy someone else's.

At the stall you can make an offer, take her price, walk away (she may call you back, but only once per haggle), or type to her. She has a hidden limit, patience that runs out, and a mood that remembers how you treated her ([`openHaggle`, `haggle`](../server/merchant.js)). A deal is a quote she posts on-chain, which you accept; she keeps it open for 2 minutes.

**The choice every time: sell now, or hold.** Each extra unit you sell her is priced lower than the last, because her shelf is fuller, and everyone's recent selling pulls her bid down for a while (by up to 25%, halving every 5 minutes). The tide may pay more in a couple of minutes, and Silas may have room in his hold. Hover over (or tap) any price to see how she worked it out.

## Every 5 minutes: half a tide

The tide runs on the block clock, with no state, in four parts of 2½ minutes each: low, rising, high, falling (`tide_at` in the contract, `tideAt` in [`web/tide.js`](../web/tide.js)). Every third tide is a spring tide, which pushes everything further. The tide clock under your bag shows where you are and what comes next.

| | Low water | High water |
|---|---|---|
| **Shore** | rock pools: 2–4 kelp (3–5 at a spring tide), 0–1 driftwood | 1–2 kelp, 1–3 driftwood (2–4 at a spring tide) |
| **Reef** | shallow: 1–2 pearls (up to 3 at a spring tide) | deep: 0–1 pearls (mostly none at a spring tide) |
| **Maren pays** | ×0.8 for kelp, ×0.85 for pearls, ×1.2 for driftwood | ×1.2 for kelp, ×1.15 for pearls, ×0.8 for driftwood |

At a spring tide those swings are 40% bigger. Ore comes from the cliffs, which stand above the tide, so its price does not swing.

Over a whole tide her offers average out to her ordinary price, so the tide rewards timing, not waiting. Within any five minutes the player:

- **gathers at low water**: the rock pools, and the reef if you have a boat;
- **sells at high water**: kelp fetches 50% more than it did at low water, and pearls 35% more (57 coins against 42 on an everyday shelf);
- **watches Silas's hold.** He holds at most 4 ore and 3 pearls ([`DEALER_HOLD`](../server/merchant.js)). With an empty hold he pays about 25 for ore and 67 for a pearl, well above Maren's 19 and 50. With a nearly full hold he pays less than she does. He ships when his hold is full, and at every high tide, so he pays least just before high water and most just after;
- **checks the board**: for bargains, for a used pickaxe or boat, or for the notices Maren and Silas pin for each other. Maren leaves a player's fresh notice alone for 15 seconds (3 minutes for a tool), so players get first pick ([`BOARD_GRACE_MS`](../server/merchant.js));
- **reads the market**: every item at the stall has a small price line for the last few minutes, and the ticker under your purse shows what other players just did. Both come from the contract's trade log;
- **saves up** for the next tool.

## Every 30 minutes: a storm

Exactly one storm blows in each half hour, for 4 minutes, starting 0, 2, 4 … or 24 minutes in. The start is picked by a public hash of the clock (`storm_at` and `mix32` in the contract, `stormAt` in [`web/tide.js`](../web/tide.js)), so anyone can forecast it, and the tide card does.

While it blows:

- the reef is closed: the contract refuses the trip;
- the shore is covered in wrack: 2–5 driftwood, 1–3 kelp, and one time in eight a pearl torn off the reef;
- pickaxes break twice as often on the wet cliffs (25%);
- the mainland boat stays in harbour, so Maren cannot export and Silas cannot ship. Silas buys nothing at all;
- Maren pays ×1.25 for pearls (62 coins on an everyday shelf) and ×0.75 for driftwood.

So the half hour has its own plan. **Before the storm:** keep pearls back. **During it:** comb the shore for wrack and sell pearls high, since nobody can fetch new ones. **After it:** the reef reopens and pearl prices fall back.

## Every session: the arc

The goal list in the corner of the screen ([`web/game.js`](../web/game.js)) is the arc:

1. **Comb the shore, sell to Maren.** A new guest starts with about 29 coins.
2. **Buy a pickaxe, mine the cliffs.** About 60 coins.
3. **Buy a boat, find pearls on the reef.** About 240 coins.
4. **Buy the beacon lens.** About 600 coins.
5. **Light the lighthouse.** The lens is burnt, your time goes on the keepers' board on the title screen, and the lighthouse shines over the village at night.

Those are her asking prices with the usual stock on the shelf ([`unitAsk`](../server/merchant.js)). She asks more when she is short (78 for her last pickaxe), never less than it cost her plus 15%, and never outside the on-chain floor and ceiling.

What makes each session different is the shared market. Everything Maren sells, she crafted from what players sold her. If the boat is sold out, the stall shows what she is missing, and bringing it to her is how the next boat gets built. Someone else may have flooded her with ore an hour ago, so ore pays little today. Silas may have just shipped, so pearls pay well.

When you are done, your boat and pickaxe can go on the board for the next newcomer. Maren doesn't buy tools back at her stall, so the board is the only place to sell a used one.

**How long it takes.** At the rates above, energy alone would allow the whole arc in about five minutes. Walking, signing, prices that fall as you sell, broken pickaxes and waiting for her to craft make it longer. We have not measured how long real players take.

## What the market does between your trips

The market keeps moving whether or not you are at the stall:

- **Maren's workshop** runs every 10 seconds while anyone has played in the last 10 minutes ([`workshopTick`](../server/server.js)). It does four things:
  - crafts what is missing: rope first, then the tools;
  - exports surplus raw goods to the mainland at fixed prices, never at a loss and never in a storm;
  - buys board notices priced under her own bid;
  - pins her surplus ore for Silas when he would pay more than the mainland.
- **Silas** ships at high tide or when his hold is full. When Maren is out of pearls for a beacon, he pins his for her.
- **Prices follow the books and recent demand.** Her bid for a good falls as her shelf fills, as her treasury runs low, and for a while after players have been selling it to her. Her asking price for a tool rises as her shelf empties and while players have been buying them ([`server/merchant.js`](../server/merchant.js)). Hover over any price at the stall to see the working.
- **The guard rails** are checked by the contract on every deal: price floors and ceilings, a spending cap of 1500 coins per 10 minutes, stock and treasury checks. A refused deal is recorded on-chain with its reason.

## Planned, not built yet

These are on the plan and are **not** in the game today:

- **Broke merchants close, and players invest:**
  - a merchant whose treasury runs too low shuts the stall;
  - players lend it money to reopen;
  - it pays them back out of its profits.

  That would add a new loop at the session scale: invest, then collect.
- **Fast-forward:** a simulation of a week of trading in a minute, using the same pricing code, so you can watch the economy move.
- **Sign in with Google**, so your stall follows you to another device.
