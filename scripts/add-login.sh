#!/usr/bin/env bash
# Turns on "Sign in with Google" for this market's server.
#
#   ./scripts/add-login.sh <Google OAuth client id>
#
# Writes three settings into server/.env (secrets are never printed):
#   GOOGLE_CLIENT_ID  the public id of your Google OAuth client (it is not a secret)
#   LOGIN_SECRET      a random secret that turns a person's Google id into their
#                     account name, so nobody can link an account to an email
#   RECOVERY_KEY      a key the server adds to every signed-in account, so the same
#                     person can add a new device later (custodial: testnet only)
# The secret and the key are made once and kept: making new ones would lose
# everyone's accounts. Nothing touches the chain until someone signs in.
#
# Getting a client id (free): console.cloud.google.com, a new project, the OAuth
# consent screen (External; app name; your support email), then Credentials,
# OAuth client ID, Web application, with your game's address as an authorised
# JavaScript origin (http://localhost:8787, and your hosted address later).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f server/.env ] || { echo "No server/.env yet: run ./scripts/bootstrap.sh first."; exit 1; }
CLIENT_ID="${1:-}"
[[ "$CLIENT_ID" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]] || { echo "Usage: ./scripts/add-login.sh <client id>, like 1234-abcd.apps.googleusercontent.com"; exit 1; }

CLIENT_ID="$CLIENT_ID" node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  const f = "server/.env";
  let env = fs.readFileSync(f, "utf8");
  if (!env.endsWith("\n")) env += "\n";
  const has = (k) => new RegExp("^" + k + "=.+", "m").test(env);
  env = env.replace(/^GOOGLE_CLIENT_ID=.*\n?/m, "") + "GOOGLE_CLIENT_ID=" + process.env.CLIENT_ID + "\n";
  if (!has("LOGIN_SECRET")) env += "LOGIN_SECRET=" + crypto.randomBytes(32).toString("hex") + "\n";
  fs.writeFileSync(f, env, { mode: 0o600 });
  console.log("  client id set" + (has("LOGIN_SECRET") ? "" : "; a new login secret made"));
'
if ! grep -qE '^RECOVERY_KEY=.+' server/.env; then
  KEYS=$(node scripts/keygen.mjs); SK=${KEYS%% *}
  SK="$SK" node -e 'const fs=require("fs");fs.appendFileSync("server/.env","RECOVERY_KEY="+process.env.SK+"\n",{mode:0o600})'
  echo "  a recovery key made"
fi
printf "\n\033[1m✅ Google sign-in is set up.\033[0m Restart the shop: node server/server.js\n"
