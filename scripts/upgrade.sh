#!/usr/bin/env bash
# Upgrades an existing market (made by bootstrap.sh) to the contract in
# contract/res/, keeping every player, item, trade and keeper.
#
#   1. Deploys the new contract. If the market's saved state is an older layout
#      (before the notice board, or before the dealer), the same transaction runs
#      `migrate`, so the code and the state change together or not at all.
#   2. If Maren's key in server/.env lacks one of her methods (they grew with the
#      notice board, loans and bids), gives her a new function-call key that has
#      them (and still nothing else) and switches server/.env to it. The same for
#      Silas's key, if he is in town. Keys are never printed.
#
# Needs the contract account's, Maren's and Silas's full-access keys in the near-cli
# legacy keychain (~/.near-credentials), where bootstrap.sh put them.
#
#   ./scripts/upgrade.sh          then restart: node server/server.js
set -euo pipefail
cd "$(dirname "$0")/.."
LOG="$(pwd)/upgrade.log"
: > "$LOG"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
run() { "$@" >>"$LOG" 2>&1 || { printf "\033[31mFailed:\033[0m %s\n--- last lines of upgrade.log ---\n" "$*"; tail -25 "$LOG"; exit 1; }; }

[ -f server/.env ] || { echo "No server/.env yet: run ./scripts/bootstrap.sh instead."; exit 1; }
get() { grep -E "^$1=" server/.env | head -1 | cut -d= -f2-; }
MARKET=$(get CONTRACT)
MERCHANT=$(get MERCHANT_ID)
WASM="contract/res/tidewater_market.wasm"
METHODS="post_quote,cancel_quote,craft,export,shop_buy_listing,shop_list_item,cancel_listing,note_insult,call_in_loan,post_order,cancel_order,start_auction,settle_auction,answer_offer"
DEALER=$(get DEALER_ID || true)
DEALER_METHODS="dealer_post_quote,dealer_cancel_quote,ship,dealer_list_item,dealer_buy_listing,cancel_listing,answer_offer"
NET="network-config testnet"
SIGN="$NET sign-with-legacy-keychain send"

# Asks the chain (read-only) whether the market's state is the current layout
# (get_market reports bid_count: orders, offers and auctions), and whether
# Maren's and Silas's current keys may call the newest of their methods
# (answer_offer). The keys go in through the environment, never the command line.
STATE=$(MERCHANT_KEY="$(get MERCHANT_KEY)" DEALER_KEY="$(get DEALER_KEY || true)" node --input-type=module -e '
  import { Near, loadKey } from "./web/near-lite.js";
  const [market, merchant, dealer] = process.argv.slice(1);
  const near = new Near(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]);
  const mv = await near.view(market, "get_market");
  const may = async (account, secret) => {
    if (!account || !secret) return "none";
    try {
      const key = await loadKey(secret);
      const ak = await near.rpc("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: key.publicKey });
      return (ak.permission.FunctionCall?.method_names ?? []).includes("answer_offer") ? "key-ok" : "key-old";
    } catch {
      return "key-old";
    }
  };
  console.log(`${"bid_count" in mv ? "current" : "old"} ${await may(merchant, process.env.MERCHANT_KEY)} ${await may(dealer, process.env.DEALER_KEY)}`);
' "$MARKET" "$MERCHANT" "$DEALER" 2>>"$LOG")
read -r LAYOUT MKEY DKEY <<<"$STATE"

if [ "$LAYOUT" = old ]; then
  step "Deploying the new contract to $MARKET and migrating its state (one transaction)"
  run near contract deploy "$MARKET" use-file "$WASM" with-init-call migrate json-args '{}' \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' $SIGN
else
  step "Deploying the new contract to $MARKET (state already up to date)"
  run near contract deploy "$MARKET" use-file "$WASM" without-init-call $SIGN
fi

if [ "$MKEY" = key-old ]; then
  step "Giving Maren a key that can ONLY quote, craft, export, trade on the notice board, note insults, call in loans, post orders, run auctions and answer offers"
  KEYS=$(node scripts/keygen.mjs); MERCHANT_SK=${KEYS%% *}; MERCHANT_PK=${KEYS##* }
  run near account add-key "$MERCHANT" grant-function-call-access \
    --allowance '0.4 NEAR' --contract-account-id "$MARKET" --function-names "$METHODS" \
    use-manually-provided-public-key "$MERCHANT_PK" $SIGN
  NEW_KEY="$MERCHANT_SK" node -e '
    const fs = require("fs");
    const f = "server/.env";
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^MERCHANT_KEY=.*$/m, "MERCHANT_KEY=" + process.env.NEW_KEY), { mode: 0o600 });
  '
  echo "  server/.env now uses the new key. (Maren's old key still exists and can do less; delete it on-chain if you like.)"
fi

if [ "$DKEY" = key-old ]; then
  step "Giving Silas a key that can ONLY quote, ship, trade on the notice board and answer offers"
  KEYS=$(node scripts/keygen.mjs); DEALER_SK=${KEYS%% *}; DEALER_PK=${KEYS##* }
  run near account add-key "$DEALER" grant-function-call-access \
    --allowance '0.25 NEAR' --contract-account-id "$MARKET" --function-names "$DEALER_METHODS" \
    use-manually-provided-public-key "$DEALER_PK" $SIGN
  NEW_KEY="$DEALER_SK" node -e '
    const fs = require("fs");
    const f = "server/.env";
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^DEALER_KEY=.*$/m, "DEALER_KEY=" + process.env.NEW_KEY), { mode: 0o600 });
  '
  echo "  server/.env now uses his new key. (His old key still exists and can do less.)"
fi

printf "\n\033[1m✅ %s is up to date.\033[0m Restart the shop: node server/server.js\n" "$MARKET"
grep -q '^DEALER_ID=' server/.env || echo "   To bring Silas, the pearl and ore dealer, to town: ./scripts/add-dealer.sh"
