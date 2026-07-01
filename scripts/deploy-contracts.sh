#!/usr/bin/env bash
# scripts/deploy-contracts.sh
# Build, optimise, and deploy ShieldPool + ASP contracts to Stellar testnet.
# Usage: DEPLOYER_SECRET=S... ./scripts/deploy-contracts.sh
# Optional: STELLAR_NETWORK=mainnet (defaults to testnet)
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
NETWORK="${STELLAR_NETWORK:-testnet}"
USDC_TESTNET="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POOL_MANIFEST="$REPO_ROOT/contracts/shield_pool/Cargo.toml"
ASP_MANIFEST="$REPO_ROOT/contracts/asp/Cargo.toml"
POOL_WASM="$REPO_ROOT/contracts/shield_pool/target/wasm32-unknown-unknown/release/shield_pool.wasm"
ASP_WASM="$REPO_ROOT/contracts/asp/target/wasm32-unknown-unknown/release/asp.wasm"
POOL_OPT="$REPO_ROOT/contracts/shield_pool/target/opt.wasm"
ASP_OPT="$REPO_ROOT/contracts/asp/target/opt.wasm"
ENV_FILE="$REPO_ROOT/frontend/.env.local"

# ── Colour helpers ───────────────────────────────────────────────────────────
green()  { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
red()    { echo -e "\033[31m$*\033[0m"; }
step()   { echo; green "▶ $*"; }

# ── Preflight ────────────────────────────────────────────────────────────────
step "Preflight checks"
[[ -n "${DEPLOYER_SECRET:-}" ]] || { red "DEPLOYER_SECRET is not set"; exit 1; }

for cmd in cargo soroban; do
  command -v "$cmd" >/dev/null || { red "$cmd not found"; exit 1; }
done

# Derive deployer address from secret
DEPLOYER_ADDRESS=$(soroban keys address "$DEPLOYER_SECRET" 2>/dev/null || \
  stellar keys address "$DEPLOYER_SECRET" 2>/dev/null || \
  soroban keys show --secret-key "$DEPLOYER_SECRET" 2>/dev/null | grep -oE 'G[A-Z0-9]{55}' | head -1)

[[ -n "$DEPLOYER_ADDRESS" ]] || {
  red "Could not derive address from DEPLOYER_SECRET. Ensure soroban-cli 21.x is installed."
  exit 1
}
green "Deployer: $DEPLOYER_ADDRESS"
green "Network:  $NETWORK"

# ── 1. Build contracts ───────────────────────────────────────────────────────
step "Building ShieldPool contract"
cargo build \
  --target wasm32-unknown-unknown \
  --release \
  --manifest-path "$POOL_MANIFEST"

step "Building ASP contract"
cargo build \
  --target wasm32-unknown-unknown \
  --release \
  --manifest-path "$ASP_MANIFEST"

# ── 2. Optimise ──────────────────────────────────────────────────────────────
step "Optimising with wasm-opt"
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --output "$POOL_OPT" "$POOL_WASM"
  wasm-opt -Oz --output "$ASP_OPT"  "$ASP_WASM"
  POOL_UPLOAD_WASM="$POOL_OPT"
  ASP_UPLOAD_WASM="$ASP_OPT"
  green "wasm-opt applied"
else
  yellow "wasm-opt not found — skipping optimisation (install binaryen for smaller contracts)"
  POOL_UPLOAD_WASM="$POOL_WASM"
  ASP_UPLOAD_WASM="$ASP_WASM"
fi

# ── 3. Upload bytecode ───────────────────────────────────────────────────────
step "Uploading ShieldPool bytecode"
SHIELD_POOL_HASH=$(soroban contract upload \
  --wasm "$POOL_UPLOAD_WASM" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK")
green "ShieldPool hash: $SHIELD_POOL_HASH"

step "Uploading ASP bytecode"
ASP_HASH=$(soroban contract upload \
  --wasm "$ASP_UPLOAD_WASM" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK")
green "ASP hash: $ASP_HASH"

# ── 4. Deploy ShieldPool first so the ASP init can reference it ─────────────
step "Deploying ShieldPool contract"
SHIELD_POOL_ID=$(soroban contract deploy \
  --wasm-hash "$SHIELD_POOL_HASH" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK")
green "ShieldPool contract ID: $SHIELD_POOL_ID"

# ── 5. Initialize ShieldPool ──────────────────────────────────────────────────
step "Initializing ShieldPool"
USDC_CONTRACT="${USDC_CONTRACT_ID:-$USDC_TESTNET}"
SUPPORTED_ASSETS_JSON="[\"$USDC_CONTRACT\"]"
soroban contract invoke \
  --id "$SHIELD_POOL_ID" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDRESS" \
  --supported_assets "$SUPPORTED_ASSETS_JSON"

# ── 6. Deploy ASP ───────────────────────────────────────────────────────────
step "Deploying ASP contract"
ASP_ID=$(soroban contract deploy \
  --wasm-hash "$ASP_HASH" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK")
green "ASP contract ID: $ASP_ID"

# ── 7. Initialize ASP with the real ShieldPool address ──────────────────────
step "Initializing ASP"
soroban contract invoke \
  --id "$ASP_ID" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDRESS" \
  --shield_pool "$SHIELD_POOL_ID"

# ── 8. Write .env.local ───────────────────────────────────────────────────────
step "Writing frontend/.env.local"
mkdir -p "$(dirname "$ENV_FILE")"

# Remove stale entries then append fresh values
if [[ -f "$ENV_FILE" ]]; then
  sed -i '/^NEXT_PUBLIC_SHIELD_POOL_CONTRACT_ID=/d' "$ENV_FILE"
  sed -i '/^NEXT_PUBLIC_ASP_CONTRACT_ID=/d'         "$ENV_FILE"
fi

{
  echo "NEXT_PUBLIC_SHIELD_POOL_CONTRACT_ID=$SHIELD_POOL_ID"
  echo "NEXT_PUBLIC_ASP_CONTRACT_ID=$ASP_ID"
  echo "NEXT_PUBLIC_USDC_CONTRACT_ID=$USDC_CONTRACT"
  echo "STELLAR_NETWORK=$NETWORK"
} >> "$ENV_FILE"
green "Wrote $ENV_FILE"

# ── 10. Summary ───────────────────────────────────────────────────────────────
echo
echo "┌─────────────────────────────────────────────────────────────────────┐"
printf "│ %-69s │\n" "ShieldSend Deployment Summary — $NETWORK"
echo "├──────────────────────┬──────────────────────────────────────────────┤"
printf "│ %-20s │ %-44s │\n" "Contract"        "Address / Hash"
echo "├──────────────────────┼──────────────────────────────────────────────┤"
printf "│ %-20s │ %-44s │\n" "ShieldPool"      "$SHIELD_POOL_ID"
printf "│ %-20s │ %-44s │\n" "ASP (Compliance)" "$ASP_ID"
printf "│ %-20s │ %-44s │\n" "USDC (testnet)"  "$USDC_CONTRACT"
printf "│ %-20s │ %-44s │\n" "Deployer"        "$DEPLOYER_ADDRESS"
echo "└──────────────────────┴──────────────────────────────────────────────┘"
echo
green "Deployment complete. Run: cd frontend && npm run dev"
