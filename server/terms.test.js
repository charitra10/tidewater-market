// The terms the game shows players (TERMS in merchant.js) are the contract's
// own: this test reads the constants out of contract/src/lib.rs. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TERMS, repLabel, repMood, haggleWhy } from "../web/merchant.js";

const rust = fs.readFileSync(new URL("../contract/src/lib.rs", import.meta.url), "utf8");
/// The value of `pub const NAME: type = <expr>;`, with `COIN` taken as 1 and `60 * 60 * 1000` worked out.
function constant(name) {
  const m = rust.match(new RegExp(`pub const ${name}: [^=]+= ([^;]+);`));
  assert.ok(m, `${name} is in lib.rs`);
  return m[1].split("*").map((x) => x.trim()).reduce((acc, x) => acc * (x === "COIN" ? 1 : Number(x)), 1);
}

test("the terms the game shows are the contract's", () => {
  assert.equal(TERMS.closeBelow, constant("CLOSE_BELOW"));
  assert.equal(TERMS.reopenAt, constant("REOPEN_AT"));
  assert.equal(TERMS.minInvest, constant("MIN_INVEST"));
  assert.equal(TERMS.maxInvest, constant("MAX_INVEST"));
  assert.equal(TERMS.iouReturnPct, constant("IOU_RETURN_PCT"));
  assert.equal(TERMS.repayPct, constant("REPAY_PCT"));
  assert.equal(TERMS.loanInterestPct, constant("LOAN_INTEREST_PCT"));
  assert.equal(TERMS.loanTermMs, constant("LOAN_TERM_MS"));
  assert.equal(TERMS.loanWithholdPct, constant("LOAN_WITHHOLD_PCT"));
  assert.equal(TERMS.coverPremium, constant("COVER_PREMIUM"));
  assert.equal(TERMS.coverPayout, constant("COVER_PAYOUT"));
  assert.equal(TERMS.maxOffersPerPlayer, constant("MAX_OFFERS_PER_PLAYER"));
  assert.equal(TERMS.offerTtlMs, constant("OFFER_TTL_MS"));
  assert.equal(TERMS.maxOrders, constant("MAX_ORDERS"));
  assert.equal(TERMS.orderMaxMs, constant("ORDER_MAX_MS"));
  assert.equal(TERMS.bidStepPct, constant("BID_STEP_PCT"));
  assert.equal(TERMS.auctionExtendMs, constant("AUCTION_EXTEND_MS"));
  assert.equal(TERMS.auctionMinMs, constant("AUCTION_MIN_MS"));
  assert.equal(TERMS.auctionMaxMs, constant("AUCTION_MAX_MS"));
});

test("your name in the village sets her mood, in words and in a haggle", () => {
  assert.deepEqual([60, 15, 14, 5, 0, -1, -9, -10, -30].map(repLabel), ["trusted", "trusted", "known", "known", "a stranger", "doubtful", "doubtful", "not to be trusted", "not to be trusted"]);
  assert.deepEqual([20, 15, 5, 0, -1, -10].map(repMood), [1, 1, 0, 0, -1, -2]);
  assert.match(haggleWhy("open", { reputation: -4 }), /heard about you/);
  assert.match(haggleWhy("open", { reputation: 20 }, { trades: 6 }), /^Your name in the village is good and you're a regular/);
  assert.doesNotMatch(haggleWhy("open", { reputation: 20 }), /\d/);
});
