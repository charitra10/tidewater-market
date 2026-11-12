#!/usr/bin/env bash
# Builds the contract and refreshes the prebuilt copy in contract/res/ that
# bootstrap.sh deploys (so people can try the game without installing Rust).
set -euo pipefail
cd "$(dirname "$0")/../contract"
cargo near build non-reproducible-wasm
mkdir -p res
cp target/near/tidewater_market.wasm res/tidewater_market.wasm
sha256sum res/tidewater_market.wasm
