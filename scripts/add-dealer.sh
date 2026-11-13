#!/usr/bin/env bash
# Brings Silas, the pearl and ore dealer, to an existing market (made by
# bootstrap.sh, and upgraded with upgrade.sh so the contract knows about him).
#
#   1. Creates his account, dealer.<owner>, and gives it a function-call key that
#      can ONLY quote, ship and trade on the notice board (nothing else, and no NEAR).
#      Run it again after an upgrade that gave him new methods: it swaps in a new key.
#   2. As the owner: brings him to town with his rules (set_dealer), fills his
#      treasury, adds storage headroom to the contract and tops up the mainland's
#      purse (he ships to the city out of it).
#   3. Writes DEALER_ID and DEALER_KEY into server/.env. Keys are never printed.
#
# Safe to run again: steps that are already done are skipped. Amounts can be
# changed with DEALER_TREASURY, MAINLAND_TOPUP and STORAGE_TOPUP (NEAR, 0 = skip).
#
#   ./scripts/add-dealer.sh          then restart: node server/server.js
set -euo pipefail
cd "$(dirname "$0")/.."
LOG="$(pwd)/add-dealer.log"
: > "$LOG"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
run() { "$@" >>"$LOG" 2>&1 || { printf "\033[31mFailed:\033[0m %s\n--- last lines of add-dealer.log ---\n" "$*"; tail -25 "$LOG"; exit 1; }; }

[ -f server/.env ] || { echo "No server/.env yet: run ./scripts/bootstrap.sh first."; exit 1; }
get() { grep -E "^$1=" server/.env | head -1 | cut -d= -f2-; }
MARKET=$(get CONTRACT)
OWNER=$(get OWNER)
[ -n "$OWNER" ] || OWNER=${MARKET#market.}
DEALER="dealer.$OWNER"
METHODS="dealer_post_quote,dealer_cancel_quote,ship,dealer_list_item,dealer_buy_listing,cancel_listing"
NET="network-config testnet"
SIGN="$NET sign-with-legacy-keychain send"
DEALER_TREASURY=${DEALER_TREASURY:-0.8}
MAINLAND_TOPUP=${MAINLAND_TOPUP:-0.8}
STORAGE_TOPUP=${STORAGE_TOPUP:-0.4}
coin() { node -e 'console.log((BigInt(process.argv[1]) * 10n ** 21n).toString())' "$1"; }

# What the chain says already (read-only): is the contract new enough, is he in
# town, does his account exist, and does server/.env hold a key that works.
STATE=$(DEALER_KEY="$(get DEALER_KEY)" node --input-type=module -e '
  import { Near, loadKey } from "./web/near-lite.js";
  const [market, dealer] = process.argv.slice(1);
  const near = new Near(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]);
  const mv = await near.view(market, "get_market");
  const exists = await near.accountExists(dealer);
  let keyOk = false;
  if (process.env.DEALER_KEY) {
    try {
      const key = await loadKey(process.env.DEALER_KEY);
      const ak = await near.rpc("query", { request_type: "view_access_key", finality: "final", account_id: dealer, public_key: key.publicKey });
      keyOk = (ak.permission.FunctionCall?.method_names ?? []).includes("dealer_buy_listing");
    } catch {}
  }
  console.log(`${"dealer_id" in mv ? "new" : "old"} ${mv.dealer_id === dealer ? "in-town" : "away"} ${exists ? "exists" : "none"} ${keyOk ? "key-ok" : "no-key"}`);
' "$MARKET" "$DEALER" 2>>"$LOG")
read -r CODE TOWN ACCOUNT KEY <<<"$STATE"
[ "$CODE" = new ] || { echo "The contract on $MARKET predates the dealer: run ./scripts/upgrade.sh first."; exit 1; }

if [ "$ACCOUNT" = none ]; then
  step "Creating $DEALER (0.3 NEAR from $OWNER, for his account and fees)"
  run near account create-account fund-myself "$DEALER" '0.3 NEAR' autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" $SIGN
fi

if [ "$KEY" = no-key ]; then
  step "Giving Silas a key that can ONLY quote, ship and trade on the notice board"
  KEYS=$(node scripts/keygen.mjs); DEALER_SK=${KEYS%% *}; DEALER_PK=${KEYS##* }
  run near account add-key "$DEALER" grant-function-call-access \
    --allowance '0.25 NEAR' --contract-account-id "$MARKET" --function-names "$METHODS" \
    use-manually-provided-public-key "$DEALER_PK" $SIGN
  NEW_ID="$DEALER" NEW_KEY="$DEALER_SK" node -e '
    const fs = require("fs");
    const f = "server/.env";
    let env = fs.readFileSync(f, "utf8").replace(/^DEALER_(ID|KEY)=.*\n?/gm, "");
    if (!env.endsWith("\n")) env += "\n";
    fs.writeFileSync(f, env + "DEALER_ID=" + process.env.NEW_ID + "\nDEALER_KEY=" + process.env.NEW_KEY + "\n", { mode: 0o600 });
  '
  echo "  server/.env now holds his account and key."
fi

call() { # call <method> <json-args> <deposit>
  run near contract call-function as-transaction "$MARKET" "$1" json-args "$2" \
    prepaid-gas '30 Tgas' attached-deposit "$3" sign-as "$OWNER" $SIGN
}
if [ "$TOWN" = away ]; then
  step "Bringing Silas to town: he may pay at most 40 for ore and 100 for pearls; the city pays him 30 and 82"
  ZERO=$(coin 0)
  POLICY="{\"ceiling\":[\"$ZERO\",\"$ZERO\",\"$(coin 40)\",\"$(coin 100)\",\"$ZERO\",\"$ZERO\",\"$ZERO\",\"$ZERO\"],\"city_price\":[\"$ZERO\",\"$ZERO\",\"$(coin 30)\",\"$(coin 82)\",\"$ZERO\",\"$ZERO\",\"$ZERO\",\"$ZERO\"],\"buy_window_limit\":\"$(coin 600)\",\"window_sec\":600}"
  call set_dealer "{\"account_id\":\"$DEALER\",\"policy\":$POLICY}" '1 yoctoNEAR'
  step "Filling his treasury ($DEALER_TREASURY NEAR); mainland's purse +$MAINLAND_TOPUP NEAR; contract storage +$STORAGE_TOPUP NEAR"
  call fund_dealer '{}' "$DEALER_TREASURY NEAR"
  [ "$MAINLAND_TOPUP" = 0 ] || call fund_mainland '{}' "$MAINLAND_TOPUP NEAR"
  [ "$STORAGE_TOPUP" = 0 ] || run near tokens "$OWNER" send-near "$MARKET" "$STORAGE_TOPUP NEAR" $SIGN
fi

printf "\n\033[1m✅ Silas is in town at %s.\033[0m Restart the shop: node server/server.js\n" "$MARKET"
