#!/usr/bin/env bash
# Build the guarantee contract and deploy it to NEAR testnet.
# Credentials come from the environment or spike/.env. The key is not printed.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --target wasm32-unknown-unknown --release
if [ ! -e node_modules ]; then
  ln -s ../spike/node_modules node_modules
fi
node scripts/deploy-testnet.mjs
