#!/usr/bin/env bash
# Runs every offline test: the contract's unit tests and Maren's pricing tests.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd contract && cargo test)
(cd server && node --test)
