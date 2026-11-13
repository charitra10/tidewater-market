#!/usr/bin/env bash
# Appoints the clerk who keeps players' shops, on an existing market (upgraded
# with upgrade.sh so the contract knows about shops).
#
#   1. Creates the clerk's account, clerk.<owner>, and gives it a function-call
#      key that can ONLY reprice notices in players' shops and answer offers on
#      them (clerk_reprice, answer_offer). The contract holds it to each shop
#      owner's floor; it can never move goods or coins.
#   2. As the owner: appoints it (set_clerk).
#   3. Writes CLERK_ID and CLERK_KEY into server/.env. Keys are never printed.
#
# Safe to run again: steps that are already done are skipped.
#
#   ./scripts/add-clerk.sh          then restart: node server/server.js
set -euo pipefail
cd "$(dirname "$0")/.."
LOG="$(pwd)/add-clerk.log"
: > "$LOG"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
run() { "$@" >>"$LOG" 2>&1 || { printf "\033[31mFailed:\033[0m %s\n--- last lines of add-clerk.log ---\n" "$*"; tail -25 "$LOG"; exit 1; }; }

[ -f server/.env ] || { echo "No server/.env yet: run ./scripts/bootstrap.sh first."; exit 1; }
get() { grep -E "^$1=" server/.env | head -1 | cut -d= -f2-; }
MARKET=$(get CONTRACT)
OWNER=$(get OWNER || true)
[ -n "$OWNER" ] || OWNER=${MARKET#market.}
CLERK="clerk.$OWNER"
METHODS="clerk_reprice,answer_offer"
NET="network-config testnet"
SIGN="$NET sign-with-legacy-keychain send"

# What the chain says already (read-only): is the contract new enough, is the
# clerk appointed, does its account exist, and does server/.env hold a key that works.
STATE=$(CLERK_KEY="$(get CLERK_KEY || true)" node --input-type=module -e '
  import { Near, loadKey } from "./web/near-lite.js";
  const [market, clerk] = process.argv.slice(1);
  const near = new Near(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]);
  const mv = await near.view(market, "get_market");
  const exists = await near.accountExists(clerk);
  let keyOk = false;
  if (process.env.CLERK_KEY) {
    try {
      const key = await loadKey(process.env.CLERK_KEY);
      const ak = await near.rpc("query", { request_type: "view_access_key", finality: "final", account_id: clerk, public_key: key.publicKey });
      keyOk = (ak.permission.FunctionCall?.method_names ?? []).includes("clerk_reprice");
    } catch {}
  }
  console.log(`${"shop_count" in mv ? "new" : "old"} ${mv.clerk_id === clerk ? "appointed" : "none"} ${exists ? "exists" : "missing"} ${keyOk ? "key-ok" : "no-key"}`);
' "$MARKET" "$CLERK" 2>>"$LOG")
read -r CODE APPOINTED ACCOUNT KEY <<<"$STATE"
[ "$CODE" = new ] || { echo "The contract on $MARKET predates player shops: run ./scripts/upgrade.sh first."; exit 1; }

if [ "$ACCOUNT" = missing ]; then
  step "Creating $CLERK (0.2 NEAR from $OWNER, for its account and fees)"
  run near account create-account fund-myself "$CLERK" '0.2 NEAR' autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" $SIGN
fi

if [ "$KEY" = no-key ]; then
  step "Giving the clerk a key that can ONLY reprice shop notices and answer offers on them"
  KEYS=$(node scripts/keygen.mjs); CLERK_SK=${KEYS%% *}; CLERK_PK=${KEYS##* }
  run near account add-key "$CLERK" grant-function-call-access \
    --allowance '0.15 NEAR' --contract-account-id "$MARKET" --function-names "$METHODS" \
    use-manually-provided-public-key "$CLERK_PK" $SIGN
  NEW_ID="$CLERK" NEW_KEY="$CLERK_SK" node -e '
    const fs = require("fs");
    const f = "server/.env";
    let env = fs.readFileSync(f, "utf8").replace(/^CLERK_(ID|KEY)=.*\n?/gm, "");
    if (!env.endsWith("\n")) env += "\n";
    fs.writeFileSync(f, env + "CLERK_ID=" + process.env.NEW_ID + "\nCLERK_KEY=" + process.env.NEW_KEY + "\n", { mode: 0o600 });
  '
  echo "  server/.env now holds the clerk's account and key."
fi

if [ "$APPOINTED" = none ]; then
  step "Appointing the clerk (set_clerk, as the owner)"
  run near contract call-function as-transaction "$MARKET" set_clerk json-args "{\"account_id\":\"$CLERK\"}" \
    prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" $SIGN
fi

printf "\n\033[1m✅ The clerk is appointed at %s.\033[0m Restart the shop: node server/server.js\n" "$MARKET"
