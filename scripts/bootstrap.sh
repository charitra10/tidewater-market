#!/usr/bin/env bash
# One-command setup of your own Tidewater Market on NEAR testnet (free, ~2 min).
#
# Creates fresh testnet accounts (an owner from the free faucet, plus the
# market contract, Maren the merchant and a guest desk), deploys the contract,
# stocks Maren's shelves, fills her treasury, gives her a key that can ONLY
# quote, craft, export and buy off the notice board, and writes server/.env.
#
#   ./scripts/bootstrap.sh            use the prebuilt contract (contract/res/)
#   BUILD=1 ./scripts/bootstrap.sh    rebuild the contract from source first
#   FORCE=1 ./scripts/bootstrap.sh    replace an existing setup (server/.env)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR=$(pwd)
LOG="$ROOT_DIR/bootstrap.log"
: > "$LOG"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
run() { "$@" >>"$LOG" 2>&1 || { printf "\033[31mFailed:\033[0m %s\n--- last lines of bootstrap.log ---\n" "$*"; tail -25 "$LOG"; exit 1; }; }
need() { command -v "$1" >/dev/null || { printf "\033[31mMissing %s.\033[0m %s\n" "$1" "$2"; exit 1; }; }

need near "Install near-cli-rs: https://github.com/near/near-cli-rs#installation"
need node "Install Node.js 20.12 or newer: https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<20||(a===20&&b<12)) { console.error("Node.js 20.12+ is required, found " + process.versions.node); process.exit(1) }'
if [ -f server/.env ] && [ "${FORCE:-0}" != 1 ]; then
  echo "server/.env already exists (you already have a setup). Re-run with FORCE=1 to create a new one."
  exit 1
fi

WASM="contract/res/tidewater_market.wasm"
if [ "${BUILD:-0}" = 1 ]; then
  step "Building the contract from source"
  need cargo "Install Rust: https://rustup.rs"
  run ./scripts/build.sh
fi
[ -f "$WASM" ] || { echo "Contract file $WASM not found. Run BUILD=1 ./scripts/bootstrap.sh"; exit 1; }

NET="network-config testnet"
SIGN="$NET sign-with-legacy-keychain send"
SUF=$(node -e 'console.log(require("crypto").randomBytes(3).toString("hex"))')
OWNER="tidewater-$SUF.testnet"
MARKET="market.$OWNER"; MERCHANT="maren.$OWNER"; GUESTS="guests.$OWNER"

step "Creating owner account $OWNER (free testnet faucet, 10 NEAR)"
run near account create-account sponsor-by-faucet-service "$OWNER" autogenerate-new-keypair \
  save-to-legacy-keychain $NET create

step "Creating $MARKET (the contract) and $MERCHANT (Maren)"
run near account create-account fund-myself "$MARKET" '3.7 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as "$OWNER" $SIGN
run near account create-account fund-myself "$MERCHANT" '0.5 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as "$OWNER" $SIGN

step "Creating $GUESTS (pays for new players' accounts)"
KEYS=$(node scripts/keygen.mjs); GUESTS_SK=${KEYS%% *}; GUESTS_PK=${KEYS##* }
run near account create-account fund-myself "$GUESTS" '1.5 NEAR' use-manually-provided-public-key "$GUESTS_PK" \
  sign-as "$OWNER" $SIGN

step "Deploying the market contract"
INIT=$(node scripts/init-args.mjs "$OWNER" "$MERCHANT")
run near contract deploy "$MARKET" use-file "$WASM" with-init-call new json-args "$INIT" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' $SIGN

call() { # call <method> <json-args> <deposit>
  run near contract call-function as-transaction "$MARKET" "$1" json-args "$2" \
    prepaid-gas '30 Tgas' attached-deposit "$3" sign-as "$OWNER" $SIGN
}
step "Filling Maren's treasury (1.2 NEAR) and the mainland's purse (1.2 NEAR)"
call fund_treasury '{}' '1.2 NEAR'
call fund_mainland '{}' '1.2 NEAR'

step "Stocking Maren's shelves"
coin() { node -e 'console.log((BigInt(process.argv[1]) * 10n ** 21n).toString())' "$1"; }
call restock "{\"token_id\":\"pickaxe\",\"qty\":2,\"unit_cost\":\"$(coin 38)\"}" '1 yoctoNEAR'
call restock "{\"token_id\":\"rope\",\"qty\":3,\"unit_cost\":\"$(coin 12)\"}" '1 yoctoNEAR'
call restock "{\"token_id\":\"driftwood\",\"qty\":4,\"unit_cost\":\"$(coin 4)\"}" '1 yoctoNEAR'
call restock "{\"token_id\":\"kelp\",\"qty\":3,\"unit_cost\":\"$(coin 3)\"}" '1 yoctoNEAR'

step "Giving Maren a key that can ONLY quote, craft, export and buy off the notice board"
KEYS=$(node scripts/keygen.mjs); MERCHANT_SK=${KEYS%% *}; MERCHANT_PK=${KEYS##* }
run near account add-key "$MERCHANT" grant-function-call-access \
  --allowance '0.4 NEAR' --contract-account-id "$MARKET" --function-names 'post_quote,cancel_quote,craft,export,shop_buy_listing' \
  use-manually-provided-public-key "$MERCHANT_PK" $SIGN

umask 077
cat > server/.env <<ENV
# Created by scripts/bootstrap.sh. Keep secret, never commit (git-ignored).
OWNER=$OWNER
CONTRACT=$MARKET
MERCHANT_ID=$MERCHANT
MERCHANT_KEY=$MERCHANT_SK
SPONSOR_ID=$GUESTS
SPONSOR_KEY=$GUESTS_SK
ENV
umask 022

step "Bringing Silas, the pearl and ore dealer, to town"
DEALER_TREASURY=0.6 MAINLAND_TOPUP=0 STORAGE_TOPUP=0 ./scripts/add-dealer.sh

echo
bold "✅ Tidewater Market is live on testnet"
echo "   owner     $OWNER   (full-access key in ~/.near-credentials/testnet/)"
echo "   contract  $MARKET"
echo "   merchant  $MERCHANT   (her key in server/.env can only quote, craft, export and buy off the board)"
echo "   guests    $GUESTS   (funds new players: 0.13 NEAR each)"
echo "   dealer    dealer.$OWNER   (Silas; his key in server/.env can only quote, cancel and ship)"
echo
bold "Next:"
echo "   1. Open the shop:     node server/server.js      then visit http://localhost:8787"
echo "   2. Watch a bot play:  node scripts/play.mjs"
