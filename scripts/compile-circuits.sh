#!/usr/bin/env bash
# scripts/compile-circuits.sh
# Compile all three ShieldSend circuits and run Groth16 trusted setup.
# Usage: ./scripts/compile-circuits.sh [--skip-ptau]
# Requires: circom 2.x, snarkjs, node 18+, openssl
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCUITS_DIR="$REPO_ROOT/circuits"
BUILD_DIR="$REPO_ROOT/build"
PTAU_DIR="$REPO_ROOT/ptau"
FRONTEND_CIRCUITS="$REPO_ROOT/frontend/public/circuits"
PTAU_FILE="$PTAU_DIR/pot20_final.ptau"
PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_20.ptau"
MAX_CONSTRAINTS=1048576  # 2^20

CIRCOM="${CIRCOM_BIN:-circom}"
SNARKJS="node $REPO_ROOT/node_modules/.bin/snarkjs"

# Prefer the local binary if present
if [[ -x "$REPO_ROOT/circom-linux-amd64" ]]; then
  CIRCOM="$REPO_ROOT/circom-linux-amd64"
fi

CIRCUITS=(deposit transfer withdraw)

# ── Colour helpers ──────────────────────────────────────────────────────────
green()  { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
red()    { echo -e "\033[31m$*\033[0m"; }
step()   { echo; green "▶ $*"; }

# ── Dependency checks ───────────────────────────────────────────────────────
step "Checking dependencies"
command -v node   >/dev/null || { red "node not found"; exit 1; }
command -v openssl >/dev/null || { red "openssl not found"; exit 1; }
[[ -x "$CIRCOM" ]] || command -v circom >/dev/null || { red "circom not found. Install with: npm i -g @iden3/circom"; exit 1; }

NODE_MAJ=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
(( NODE_MAJ >= 18 )) || { red "Node.js 18+ required (found $NODE_MAJ)"; exit 1; }

if [[ ! -f "$REPO_ROOT/node_modules/.bin/snarkjs" ]]; then
  yellow "snarkjs not found locally — installing..."
  npm install --prefix "$REPO_ROOT" snarkjs
fi

# ── Download ptau ───────────────────────────────────────────────────────────
mkdir -p "$PTAU_DIR"
if [[ ! -f "$PTAU_FILE" ]]; then
  if [[ "${1:-}" == "--skip-ptau" ]]; then
    red "ptau file not found and --skip-ptau was set. Aborting."
    exit 1
  fi
  step "Downloading Hermez pot20_final.ptau (~700 MB)…"
  curl -L --progress-bar "$PTAU_URL" -o "$PTAU_FILE"
  green "Download complete: $PTAU_FILE"
else
  green "Using cached ptau: $PTAU_FILE"
fi

mkdir -p "$FRONTEND_CIRCUITS"

# ── Per-circuit build ───────────────────────────────────────────────────────
for NAME in "${CIRCUITS[@]}"; do
  OUT="$BUILD_DIR/$NAME"
  mkdir -p "$OUT"

  step "[$NAME] Compiling circuit"
  "$CIRCOM" "$CIRCUITS_DIR/$NAME.circom" \
    --r1cs --wasm --sym \
    -l "$REPO_ROOT/node_modules" \
    -o "$OUT"

  # snarkjs emits the wasm one level deeper inside a _js/ folder
  WASM_SRC="$OUT/${NAME}_js/${NAME}.wasm"
  if [[ -f "$WASM_SRC" ]]; then
    cp "$WASM_SRC" "$OUT/${NAME}.wasm"
  fi

  step "[$NAME] Constraint count"
  CONSTRAINTS=$($SNARKJS r1cs info "$OUT/$NAME.r1cs" 2>&1 | grep -i "constraints" | grep -oE "[0-9]+" | head -1 || echo "0")
  green "  constraints: $CONSTRAINTS"
  if (( CONSTRAINTS > MAX_CONSTRAINTS )); then
    red "  ⚠ WARNING: $CONSTRAINTS > 2^20 ($MAX_CONSTRAINTS). pot20_final.ptau is insufficient!"
    red "  Download a larger ptau (pot21+) and update PTAU_FILE in this script."
  fi

  step "[$NAME] Groth16 setup (phase 2)"
  $SNARKJS groth16 setup \
    "$OUT/$NAME.r1cs" \
    "$PTAU_FILE" \
    "$OUT/${NAME}_0000.zkey"

  step "[$NAME] Contribute entropy"
  ENTROPY="$(openssl rand -hex 32)"
  $SNARKJS zkey contribute \
    "$OUT/${NAME}_0000.zkey" \
    "$OUT/${NAME}_final.zkey" \
    --name="ShieldSend Hackathon" \
    -v \
    -e="$ENTROPY"

  step "[$NAME] Export verification key"
  $SNARKJS zkey export verificationkey \
    "$OUT/${NAME}_final.zkey" \
    "$OUT/verification_key.json"

  step "[$NAME] Export Solidity verifier (reference only)"
  $SNARKJS zkey export solidityverifier \
    "$OUT/${NAME}_final.zkey" \
    "$OUT/${NAME}_verifier.sol"

  step "[$NAME] Copy artefacts to frontend"
  cp "$OUT/${NAME}.wasm"       "$FRONTEND_CIRCUITS/${NAME}.wasm"
  cp "$OUT/${NAME}_final.zkey" "$FRONTEND_CIRCUITS/${NAME}_final.zkey"

  green "[$NAME] ✓ done"
done

# ── Extract VK to Rust ──────────────────────────────────────────────────────
step "Extracting verification keys to Rust constants"
node "$REPO_ROOT/scripts/extract-vk.js"

green ""
green "All circuits compiled successfully."
green "Artefacts:  build/{deposit,transfer,withdraw}/"
green "Frontend:   frontend/public/circuits/"
green "Rust VK:    contracts/shield_pool/src/vk_constants.rs"
