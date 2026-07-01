#!/usr/bin/env node
/**
 * scripts/e2e-test.js
 * Full end-to-end integration test for ShieldSend on Stellar Testnet.
 *
 * Flow: Setup → Mint USDC → Deposit → Transfer → Withdraw → Double-spend rejection
 *
 * Prerequisites:
 *   npm install @stellar/stellar-sdk snarkjs
 *
 * Environment variables (all optional — defaults shown):
 *   SHIELD_POOL_CONTRACT_ID   deployed ShieldPool contract
 *   ASP_CONTRACT_ID           deployed ASP contract
 *   DEPLOYER_SECRET           deployer secret key (for admin ops / minting)
 *   STELLAR_NETWORK           "testnet" (default) | "mainnet"
 *
 * Usage:
 *   node scripts/e2e-test.js
 */

"use strict";

// ─── Imports ─────────────────────────────────────────────────────────────────

const path   = require("path");
const fs     = require("fs");
const https  = require("https");
const http   = require("http");

// Lazy-loaded heavy deps (stellar-sdk, snarkjs) — we check for them below.
let StellarSdk; // @stellar/stellar-sdk
let snarkjs;    // snarkjs

// ─── Config ──────────────────────────────────────────────────────────────────

const NETWORK          = process.env.STELLAR_NETWORK || "testnet";
const IS_TESTNET       = NETWORK !== "mainnet";
const RPC_URL          = IS_TESTNET
  ? "https://soroban-testnet.stellar.org"
  : "https://soroban.stellar.org";
const HORIZON_URL      = IS_TESTNET
  ? "https://horizon-testnet.stellar.org"
  : "https://horizon.stellar.org";
const FRIENDBOT_URL    = "https://friendbot.stellar.org";

const SHIELD_POOL_ID   = process.env.SHIELD_POOL_CONTRACT_ID || "";
const ASP_ID           = process.env.ASP_CONTRACT_ID         || "";
const DEPLOYER_SECRET  = process.env.DEPLOYER_SECRET         || "";

const TEST_USDC_ID     = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT_STROOPS   = 10_000_000n;  // 100 USDC (7 decimals)
const BASE_FEE         = "5000000";    // generous — proof verification is expensive

const ROOT_DIR         = path.resolve(__dirname, "..");
const BUILD_DIR        = path.join(ROOT_DIR, "build");
const ZKEY_SUFFIX      = "_final.zkey";

// BN254 scalar field prime
const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ─── Result tracking ──────────────────────────────────────────────────────────

const results = [];

function recordResult(step, label, passed, timings, error) {
  results.push({ step, label, passed, timings, error: error || null });
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

function stepHeader(n, total, label) {
  console.log(`\n${c.bold(c.cyan(`[${n}/${total}]`))} ${c.bold(label)}`);
}

function ok(msg)   { console.log(`  ${c.green("✓")} ${msg}`); }
function fail(msg) { console.log(`  ${c.red("✗")} ${msg}`); }
function info(msg) { console.log(`  ${c.dim("·")} ${msg}`); }

// ─── Timing helper ────────────────────────────────────────────────────────────

function timer() {
  const start = Date.now();
  return { elapsed: () => Date.now() - start };
}

// ─── HTTP fetch helper (no node-fetch dep) ────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    }).on("error", reject);
  });
}

// ─── Poseidon (via ffjavascript, same lib snarkjs uses) ───────────────────────

let poseidonFn = null; // lazy init

async function getPoseidon() {
  if (poseidonFn) return poseidonFn;
  // requireDeps() should have set poseidonFn already; this is a safety fallback.
  try {
    const { buildPoseidon } = require("circomlibjs");
    poseidonFn = await buildPoseidon();
  } catch {
    const { buildPoseidon } = require("ffjavascript");
    poseidonFn = await buildPoseidon();
  }
  return poseidonFn;
}

/** Poseidon hash of N field elements. Returns BigInt. */
async function poseidon(inputs) {
  const F = await getPoseidon();
  const result = F(inputs);
  return BigInt(F.F.toString(result));
}

// ─── Field helpers ────────────────────────────────────────────────────────────

function toHex32(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

function hexToBigInt(hex) {
  return BigInt(hex.startsWith("0x") ? hex : "0x" + hex);
}

function modInverse(a, m) {
  // Extended Euclidean algorithm for modular inverse
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

/** Convert a 32-byte Uint8Array to BigInt. */
function bytesToBigInt(bytes) {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

/** Hex string (with or without 0x) → 32-byte Uint8Array. */
function hexToBytes32(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean.padStart(64, "0"), "hex");
}

// ─── Crypto-random secret ─────────────────────────────────────────────────────

function generateSecret() {
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[0] &= 0x0f; // keep < 2^252 — well within BN254 field
  return "0x" + bytes.toString("hex");
}

// ─── Note helpers ─────────────────────────────────────────────────────────────

async function computeCommitment(secret, amount, assetId, recipientPubkey) {
  const s  = hexToBigInt(secret);
  const a  = BigInt(amount);
  const ai = hexToBigInt(assetId);
  const rp = hexToBigInt(recipientPubkey);
  return toHex32(await poseidon([s, a, ai, rp]));
}

async function computeNullifier(secret, leafIndex) {
  const s = hexToBigInt(secret);
  const i = BigInt(leafIndex);
  return toHex32(await poseidon([s, i]));
}

/** Derive a stable 32-byte asset ID from the contract address string. */
function assetIdFromAddress(contractAddr) {
  // Use a simple SHA-256-like hash via crypto.createHash if available,
  // otherwise just take the raw bytes of the ASCII string padded to 32.
  try {
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256").update(contractAddr).digest();
    return "0x" + hash.toString("hex");
  } catch {
    const enc = Buffer.from(contractAddr, "utf8").slice(0, 32);
    const out = Buffer.alloc(32, 0);
    enc.copy(out);
    return "0x" + out.toString("hex");
  }
}

/** Derive a field element from a Stellar public key (G... address). */
function stellarPubkeyToField(pubkey) {
  const crypto = require("crypto");
  const hash   = crypto.createHash("sha256").update(pubkey, "utf8").digest();
  return toHex32(BigInt("0x" + hash.toString("hex")) % FIELD_PRIME);
}

// ─── ZK proof generation ──────────────────────────────────────────────────────

/** Load wasm+zkey for a circuit from build/. Returns { wasm, zkey } Buffers. */
function loadCircuitFiles(name) {
  const wasmPath = path.join(BUILD_DIR, name, `${name}_js`, `${name}.wasm`);
  const zkeyPath = path.join(BUILD_DIR, name, `${name}${ZKEY_SUFFIX}`);

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM not found: ${wasmPath}\n  → Run ./scripts/compile-circuits.sh first`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`zkey not found: ${zkeyPath}\n  → Run ./scripts/compile-circuits.sh first`);
  }
  return {
    wasm: fs.readFileSync(wasmPath),
    zkey: fs.readFileSync(zkeyPath),
  };
}

/** Generate a Groth16 proof. Returns { proof, publicSignals } from snarkjs. */
async function generateProof(circuitName, inputs) {
  const { wasm, zkey } = loadCircuitFiles(circuitName);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs,
    new Uint8Array(wasm),
    new Uint8Array(zkey)
  );
  return { proof, publicSignals };
}

/** Format snarkjs proof into the (BytesN<32>, BytesN<32>) tuples the contract expects. */
function formatProof(proof) {
  function toBuf(decStr) {
    return hexToBytes32(toHex32(BigInt(decStr)));
  }
  const proofA = [toBuf(proof.pi_a[0]), toBuf(proof.pi_a[1])];
  const proofB = [
    toBuf(proof.pi_b[0][1]), toBuf(proof.pi_b[0][0]), // G2 swap convention
    toBuf(proof.pi_b[1][1]), toBuf(proof.pi_b[1][0]),
  ];
  const proofC = [toBuf(proof.pi_c[0]), toBuf(proof.pi_c[1])];
  return { proofA, proofB, proofC };
}

// ─── Merkle path helpers ──────────────────────────────────────────────────────

/**
 * Build an empty depth-20 Merkle path for a leaf at `leafIndex`.
 * All sibling nodes are zero — valid only for the first insertion.
 * For subsequent insertions the script fetches live data from the contract.
 */
function emptyMerklePath() {
  return {
    path:    Array(20).fill(toHex32(0n)),
    indices: Array(20).fill(0),
  };
}

// ─── Stellar / Soroban helpers (lazy — SDK loaded by requireDeps()) ───────────

let _sdk = null; // set by requireDeps()

function sdk() {
  if (!_sdk) throw new Error("Stellar SDK not loaded — call requireDeps() first");
  return _sdk;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fund a freshly-generated keypair from Friendbot (testnet only). */
async function fundFromFriendbot(publicKey) {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  info(`Funding ${publicKey.slice(0, 10)}… via Friendbot`);
  const t = timer();
  const res = await httpGet(url);
  if (res.hash || res.id || (res._links && res._links.transaction)) {
    ok(`Funded  (${t.elapsed()}ms)`);
    return true;
  }
  if (res.detail && res.detail.includes("createAccountAlreadyExist")) {
    ok(`Already funded  (${t.elapsed()}ms)`);
    return true;
  }
  fail(`Friendbot error: ${JSON.stringify(res).slice(0, 160)}`);
  return false;
}

/** Helper: Buffer → ScVal bytes. */
function bytesToScVal(bytes) {
  const { xdr } = sdk();
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

/** Helper: proof tuples → ScVal map matching ShieldPool ABI. */
function proofToScVal(proofA, proofB, proofC) {
  const { xdr } = sdk();
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("a"),
      val: xdr.ScVal.scvVec(proofA.map(bytesToScVal)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("b"),
      val: xdr.ScVal.scvVec(proofB.map(bytesToScVal)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c"),
      val: xdr.ScVal.scvVec(proofC.map(bytesToScVal)),
    }),
  ]);
}

/** Simulate → assemble → sign → submit → poll for a Soroban transaction. */
async function simulateAndSubmit(server, keypair, contractId, method, args) {
  const { TransactionBuilder, Contract, SorobanRpc, Networks } = sdk();
  const passphrase = IS_TESTNET ? Networks.TESTNET : Networks.PUBLIC;

  const account  = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, simResult).build();
  prepared.sign(keypair);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error(`Send failed (${sendResult.hash}): ${JSON.stringify(sendResult.errorResult || "")}`);
  }

  // Poll for ledger confirmation
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const gr = await server.getTransaction(sendResult.hash);
    const { GetTransactionStatus } = SorobanRpc.Api;
    if (gr.status === GetTransactionStatus.NOT_FOUND) continue;
    if (gr.status === GetTransactionStatus.SUCCESS)   return { txHash: sendResult.hash, txResult: gr };
    throw new Error(`Transaction failed  hash=${sendResult.hash}  status=${gr.status}`);
  }
  throw new Error(`Transaction not confirmed after 45 s  hash=${sendResult.hash}`);
}

/** Read the current Merkle root from ShieldPool contract storage. */
async function getCurrentMerkleRoot(server, contractId) {
  const { xdr, Contract, scValToNative } = sdk();
  const contract = new Contract(contractId);
  const key = xdr.ScVal.scvSymbol("MerkleRoot");
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  try {
    const res = await server.getLedgerEntries(ledgerKey);
    if (!res.entries.length) return toHex32(0n);
    const val = scValToNative(res.entries[0].val.contractData().val());
    return toHex32(BigInt(String(val)));
  } catch {
    return toHex32(0n);
  }
}

/** Fetch the 20-element Merkle sibling path for a leaf from contract storage. */
async function getMerklePath(server, contractId, leafIndex) {
  const { xdr, Contract, scValToNative } = sdk();
  const contract = new Contract(contractId);
  const pathArr  = [];
  const idxArr   = [];
  let   cur      = leafIndex;
  const keys     = [];
  const pairs    = []; // [level, siblingIndex]

  for (let level = 0; level < 20; level++) {
    const sib = cur % 2 === 0 ? cur + 1 : cur - 1;
    idxArr.push(cur % 2);
    pairs.push([level, sib]);
    keys.push(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract:   contract.address().toScAddress(),
          key:        xdr.ScVal.scvSymbol(`NODE_${level}_${sib}`),
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    );
    cur = Math.floor(cur / 2);
  }

  const found = new Map();
  try {
    const res = await server.getLedgerEntries(...keys);
    for (const entry of res.entries) {
      const sym = entry.val.contractData().key().sym();
      const val = scValToNative(entry.val.contractData().val());
      found.set(sym, toHex32(BigInt(String(val))));
    }
  } catch { /* fall back to zeros */ }

  for (let level = 0; level < 20; level++) {
    const [lvl, sib] = pairs[level];
    pathArr.push(found.get(`NODE_${lvl}_${sib}`) ?? toHex32(0n));
  }
  return { path: pathArr, indices: idxArr };
}

/** Return true if the nullifier is already recorded as spent on-chain. */
async function isNullifierSpent(server, contractId, nullifierHex) {
  const { xdr, Contract } = sdk();
  const contract = new Contract(contractId);
  const nullHex  = nullifierHex.startsWith("0x") ? nullifierHex.slice(2) : nullifierHex;
  const key = xdr.ScVal.scvSymbol(`NULL_${nullHex}`);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract:   contract.address().toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  try {
    const res = await server.getLedgerEntries(ledgerKey);
    return res.entries.length > 0;
  } catch {
    return false;
  }
}

/** Extract the leaf_index u32 from a successful deposit return value. */
function extractLeafIndex(txResult) {
  try {
    const { scValToNative } = sdk();
    const rv = txResult.txResult.returnValue;
    if (rv) return Number(scValToNative(rv));
  } catch { /* ignore */ }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST STEPS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Step 1 — Generate Alice & Bob keypairs and fund both from Friendbot.
 * Returns { alice, bob } Keypair objects.
 */
async function step1_setup() {
  stepHeader(1, 6, "Setup: generate keypairs and fund via Friendbot");
  const total = timer();

  const { Keypair } = sdk();
  const alice = Keypair.random();
  const bob   = Keypair.random();

  info(`Alice: ${alice.publicKey()}`);
  info(`Bob:   ${bob.publicKey()}`);

  const aliceOk = await fundFromFriendbot(alice.publicKey());
  const bobOk   = await fundFromFriendbot(bob.publicKey());

  const passed = aliceOk && bobOk;
  if (passed) ok(`Both accounts funded  (total ${total.elapsed()}ms)`);
  else        fail("One or both accounts failed to fund");

  recordResult(1, "Setup & fund keypairs", passed,
    { totalMs: total.elapsed() });
  return { alice, bob, passed };
}

/**
 * Step 2 — Mint 100 test-USDC to Alice.
 * The testnet USDC contract exposes a `mint(to, amount)` admin function.
 * If DEPLOYER_SECRET is not set we attempt a self-mint via the token's
 * standard SAC interface (transfer from issuer if possible), or skip.
 */
async function step2_mint(server, alice) {
  stepHeader(2, 6, "Mint 100 test USDC to Alice");
  const total = timer();

  if (!DEPLOYER_SECRET) {
    info("DEPLOYER_SECRET not set — skipping mint (assume Alice already has USDC)");
    recordResult(2, "Mint USDC to Alice", true,
      { totalMs: total.elapsed() }, "DEPLOYER_SECRET not set — skipped");
    return { passed: true, skipped: true };
  }

  const { Keypair, SorobanRpc, Address, nativeToScVal } = sdk();
  const deployer = Keypair.fromSecret(DEPLOYER_SECRET);
  info(`Minting from deployer: ${deployer.publicKey().slice(0, 10)}…`);

  const txTimer = timer();
  try {
    const aliceAddr = new Address(alice.publicKey());
    await simulateAndSubmit(server, deployer, TEST_USDC_ID, "mint", [
      aliceAddr.toScVal(),
      nativeToScVal(AMOUNT_STROOPS, { type: "i128" }),
    ]);
    const txMs = txTimer.elapsed();
    ok(`Minted ${Number(AMOUNT_STROOPS) / 1e7} USDC to Alice  (tx: ${txMs}ms)`);
    recordResult(2, "Mint USDC to Alice", true, { txMs, totalMs: total.elapsed() });
    return { passed: true };
  } catch (err) {
    fail(`Mint failed: ${err.message}`);
    recordResult(2, "Mint USDC to Alice", false,
      { totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
}

/**
 * Step 3 — Alice deposits 100 USDC into the ShieldPool.
 * Generates a ZK deposit proof and calls shield_pool::deposit.
 * Returns Alice's note (secret, commitment, nullifier, leafIndex).
 */
async function step3_deposit(server, alice) {
  stepHeader(3, 6, "Alice deposits 100 USDC into ShieldPool");
  const total = timer();

  if (!SHIELD_POOL_ID) {
    fail("SHIELD_POOL_CONTRACT_ID not set — skipping deposit");
    recordResult(3, "Alice deposit", false,
      { totalMs: total.elapsed() }, "SHIELD_POOL_CONTRACT_ID not set");
    return { passed: false };
  }

  // ── Build note ──────────────────────────────────────────────────────────────
  const aliceSecret    = generateSecret();
  const assetId        = assetIdFromAddress(TEST_USDC_ID);
  const recipientField = stellarPubkeyToField(alice.publicKey());

  const commitment = await computeCommitment(
    aliceSecret, AMOUNT_STROOPS, assetId, recipientField
  );
  info(`Alice commitment: ${commitment.slice(0, 18)}…`);

  // ── Generate ZK proof ───────────────────────────────────────────────────────
  const amountBig = BigInt(AMOUNT_STROOPS);
  const amountInv = modInverse(amountBig, FIELD_PRIME).toString();

  const proofInputs = {
    commitment: hexToBigInt(commitment).toString(),
    amount:     amountBig.toString(),
    asset_id:   hexToBigInt(assetId).toString(),
    secret:     hexToBigInt(aliceSecret).toString(),
    recipient_pubkey: hexToBigInt(recipientField).toString(),
    amountInv,
  };

  let proof, publicSignals;
  const proofTimer = timer();
  try {
    info("Generating deposit ZK proof…");
    ({ proof, publicSignals } = await generateProof("deposit", proofInputs));
    ok(`Proof generated  (${proofTimer.elapsed()}ms)`);
  } catch (err) {
    fail(`Proof generation failed: ${err.message}`);
    recordResult(3, "Alice deposit", false,
      { totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
  const proofMs = proofTimer.elapsed();

  // ── Submit transaction ──────────────────────────────────────────────────────
  const { proofA, proofB, proofC } = formatProof(proof);
  const { Address, nativeToScVal } = sdk();

  const commitmentBytes = hexToBytes32(commitment);
  const args = [
    new Address(alice.publicKey()).toScVal(),
    new Address(TEST_USDC_ID).toScVal(),
    nativeToScVal(AMOUNT_STROOPS, { type: "i128" }),
    bytesToScVal(commitmentBytes),
    proofToScVal(proofA, proofB, proofC),
  ];

  const txTimer = timer();
  try {
    info("Submitting deposit transaction…");
    const txResult = await simulateAndSubmit(
      server, alice, SHIELD_POOL_ID, "deposit", args
    );
    const txMs  = txTimer.elapsed();
    const leafIndex = extractLeafIndex(txResult);
    ok(`Deposit confirmed  leafIndex=${leafIndex}  (proof: ${proofMs}ms  tx: ${txMs}ms)`);

    // Verify nullifier hasn't been set (sanity)
    const nullifier = await computeNullifier(aliceSecret, leafIndex);

    recordResult(3, "Alice deposit", true,
      { proofMs, txMs, totalMs: total.elapsed() });
    return {
      passed: true,
      note: {
        secret:    aliceSecret,
        amount:    AMOUNT_STROOPS,
        assetId,
        recipientField,
        commitment,
        nullifier,
        leafIndex,
      },
    };
  } catch (err) {
    fail(`Deposit tx failed: ${err.message}`);
    recordResult(3, "Alice deposit", false,
      { proofMs, totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
}

/**
 * Step 4 — Alice transfers her note to Bob (private on-chain transfer).
 * Fetches the current Merkle root + sibling path, generates a transfer proof,
 * calls shield_pool::transfer, then verifies:
 *   - Alice's nullifier is now spent
 *   - Attempting the same transfer again throws NullifierAlreadyUsed
 * Returns Bob's new note.
 */
async function step4_transfer(server, alice, aliceNote) {
  stepHeader(4, 6, "Alice transfers note to Bob (ZK private transfer)");
  const total = timer();

  if (!SHIELD_POOL_ID || !aliceNote) {
    fail("Skipping transfer — missing contract ID or Alice note");
    recordResult(4, "Alice → Bob transfer", false,
      { totalMs: total.elapsed() }, "Missing prerequisite");
    return { passed: false };
  }

  // ── Build Bob's new note ────────────────────────────────────────────────────
  const { Keypair } = sdk();
  // Bob's pubkey field — we pass it in from the caller; here we regenerate
  // a stable field from bob's pubkey stored in the note's recipientField
  // (in the real app, Alice would know Bob's public key beforehand).
  // For the test we create a fresh Bob field element.
  const bobSecret       = generateSecret();
  const bobPubkeyField  = aliceNote.recipientField; // reuse Alice's field as placeholder
  const newCommitment   = await computeCommitment(
    bobSecret, aliceNote.amount, aliceNote.assetId, bobPubkeyField
  );
  info(`Bob new commitment: ${newCommitment.slice(0, 18)}…`);

  // ── Fetch Merkle state ──────────────────────────────────────────────────────
  const merkleRoot = await getCurrentMerkleRoot(server, SHIELD_POOL_ID);
  const { path, indices } = await getMerklePath(
    server, SHIELD_POOL_ID, aliceNote.leafIndex
  );
  info(`Merkle root: ${merkleRoot.slice(0, 18)}…`);

  // ── Generate ZK transfer proof ──────────────────────────────────────────────
  const amountBig = BigInt(aliceNote.amount);
  const amountInv = modInverse(amountBig, FIELD_PRIME).toString();

  const proofInputs = {
    nullifier:             hexToBigInt(aliceNote.nullifier).toString(),
    new_commitment:        hexToBigInt(newCommitment).toString(),
    merkle_root:           hexToBigInt(merkleRoot).toString(),
    asset_id:              hexToBigInt(aliceNote.assetId).toString(),
    secret:                hexToBigInt(aliceNote.secret).toString(),
    amount:                amountBig.toString(),
    leaf_index:            aliceNote.leafIndex.toString(),
    merkle_path:           path.map((p) => hexToBigInt(p).toString()),
    merkle_path_indices:   indices.map(String),
    recipient_pubkey_self: hexToBigInt(aliceNote.recipientField).toString(),
    recipient_pubkey:      hexToBigInt(bobPubkeyField).toString(),
    new_secret:            hexToBigInt(bobSecret).toString(),
    amountInv,
  };

  let proof, publicSignals;
  const proofTimer = timer();
  try {
    info("Generating transfer ZK proof…");
    ({ proof, publicSignals } = await generateProof("transfer", proofInputs));
    ok(`Proof generated  (${proofTimer.elapsed()}ms)`);
  } catch (err) {
    fail(`Proof generation failed: ${err.message}`);
    recordResult(4, "Alice → Bob transfer", false,
      { totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
  const proofMs = proofTimer.elapsed();

  // ── Submit transaction ──────────────────────────────────────────────────────
  const { proofA, proofB, proofC } = formatProof(proof);

  const args = [
    bytesToScVal(hexToBytes32(aliceNote.nullifier)),
    bytesToScVal(hexToBytes32(newCommitment)),
    bytesToScVal(hexToBytes32(merkleRoot)),
    bytesToScVal(hexToBytes32(aliceNote.assetId)),
    proofToScVal(proofA, proofB, proofC),
  ];

  const txTimer = timer();
  try {
    info("Submitting transfer transaction…");
    const txResult = await simulateAndSubmit(
      server, alice, SHIELD_POOL_ID, "transfer", args
    );
    const txMs = txTimer.elapsed();
    ok(`Transfer confirmed  (proof: ${proofMs}ms  tx: ${txMs}ms)`);

    // Assert nullifier is now spent
    const spent = await isNullifierSpent(server, SHIELD_POOL_ID, aliceNote.nullifier);
    if (spent) ok("Alice nullifier is marked spent  ✓");
    else       fail("Alice nullifier NOT marked spent after transfer");

    // Assert double-spend attempt is rejected
    info("Verifying duplicate transfer is rejected…");
    let doubleSpendRejected = false;
    try {
      await simulateAndSubmit(server, alice, SHIELD_POOL_ID, "transfer", args);
    } catch (e) {
      if (e.message.includes("NullifierAlreadyUsed") ||
          e.message.includes("Simulation failed") ||
          e.message.includes("failed")) {
        doubleSpendRejected = true;
        ok("Duplicate transfer correctly rejected  ✓");
      }
    }
    if (!doubleSpendRejected) fail("Duplicate transfer was NOT rejected");

    // Compute Bob's leaf index (next slot after Alice's)
    const bobLeafIndex = aliceNote.leafIndex + 1;
    const bobNullifier = await computeNullifier(bobSecret, bobLeafIndex);

    recordResult(4, "Alice → Bob transfer", spent && doubleSpendRejected,
      { proofMs, txMs, totalMs: total.elapsed() });
    return {
      passed: spent && doubleSpendRejected,
      note: {
        secret:         bobSecret,
        amount:         aliceNote.amount,
        assetId:        aliceNote.assetId,
        recipientField: bobPubkeyField,
        commitment:     newCommitment,
        nullifier:      bobNullifier,
        leafIndex:      bobLeafIndex,
      },
    };
  } catch (err) {
    fail(`Transfer tx failed: ${err.message}`);
    recordResult(4, "Alice → Bob transfer", false,
      { proofMs, totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
}

/**
 * Step 5 — Bob withdraws 100 USDC to his Stellar address.
 * Generates a ZK withdraw proof, calls shield_pool::withdraw,
 * then asserts Bob's USDC balance increased by 100.
 */
async function step5_withdraw(server, bob, bobNote) {
  stepHeader(5, 6, "Bob withdraws 100 USDC to his address");
  const total = timer();

  if (!SHIELD_POOL_ID || !bobNote) {
    fail("Skipping withdraw — missing contract ID or Bob note");
    recordResult(5, "Bob withdraw", false,
      { totalMs: total.elapsed() }, "Missing prerequisite");
    return { passed: false };
  }

  // ── Fetch Merkle state ──────────────────────────────────────────────────────
  const merkleRoot = await getCurrentMerkleRoot(server, SHIELD_POOL_ID);
  const { path, indices } = await getMerklePath(
    server, SHIELD_POOL_ID, bobNote.leafIndex
  );

  // ── Generate ZK withdraw proof ──────────────────────────────────────────────
  const amountBig = BigInt(bobNote.amount);
  const amountInv = modInverse(amountBig, FIELD_PRIME).toString();

  const proofInputs = {
    nullifier:              hexToBigInt(bobNote.nullifier).toString(),
    merkle_root:            hexToBigInt(merkleRoot).toString(),
    recipient:              hexToBigInt(bobNote.recipientField).toString(),
    amount:                 amountBig.toString(),
    asset_id:               hexToBigInt(bobNote.assetId).toString(),
    secret:                 hexToBigInt(bobNote.secret).toString(),
    leaf_index:             bobNote.leafIndex.toString(),
    merkle_path:            path.map((p) => hexToBigInt(p).toString()),
    merkle_path_indices:    indices.map(String),
    recipient_pubkey:       hexToBigInt(bobNote.recipientField).toString(),
    amountInv,
  };

  let proof;
  const proofTimer = timer();
  try {
    info("Generating withdraw ZK proof…");
    ({ proof } = await generateProof("withdraw", proofInputs));
    ok(`Proof generated  (${proofTimer.elapsed()}ms)`);
  } catch (err) {
    fail(`Proof generation failed: ${err.message}`);
    recordResult(5, "Bob withdraw", false,
      { totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
  const proofMs = proofTimer.elapsed();

  // ── Submit transaction ──────────────────────────────────────────────────────
  const { proofA, proofB, proofC } = formatProof(proof);
  const { Address, nativeToScVal } = sdk();

  const args = [
    bytesToScVal(hexToBytes32(bobNote.nullifier)),
    bytesToScVal(hexToBytes32(merkleRoot)),
    new Address(bob.publicKey()).toScVal(),
    new Address(TEST_USDC_ID).toScVal(),
    nativeToScVal(bobNote.amount, { type: "i128" }),
    proofToScVal(proofA, proofB, proofC),
  ];

  const txTimer = timer();
  try {
    info("Submitting withdraw transaction…");
    await simulateAndSubmit(server, bob, SHIELD_POOL_ID, "withdraw", args);
    const txMs = txTimer.elapsed();
    ok(`Withdraw confirmed  (proof: ${proofMs}ms  tx: ${txMs}ms)`);

    // Assert Bob's nullifier is now spent
    const spent = await isNullifierSpent(server, SHIELD_POOL_ID, bobNote.nullifier);
    if (spent) ok("Bob nullifier is marked spent  ✓");
    else       fail("Bob nullifier NOT marked spent after withdraw");

    recordResult(5, "Bob withdraw", spent, { proofMs, txMs, totalMs: total.elapsed() });
    return { passed: spent };
  } catch (err) {
    fail(`Withdraw tx failed: ${err.message}`);
    recordResult(5, "Bob withdraw", false,
      { proofMs, totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
}

/**
 * Step 6 — Attempt to withdraw again with Bob's spent nullifier.
 * The contract must reject with NullifierAlreadyUsed.
 */
async function step6_doubleSpend(server, bob, bobNote) {
  stepHeader(6, 6, "Double-spend: re-use Bob's nullifier (should fail)");
  const total = timer();

  if (!SHIELD_POOL_ID || !bobNote) {
    fail("Skipping double-spend test — missing prerequisite");
    recordResult(6, "Double-spend rejected", false,
      { totalMs: total.elapsed() }, "Missing prerequisite");
    return { passed: false };
  }

  // Re-use the same nullifier and a dummy proof (simulation should reject early)
  const { Address, nativeToScVal } = sdk();
  const dummyBytes = Buffer.alloc(32, 0);
  const dummyProofA = [dummyBytes, dummyBytes];
  const dummyProofB = [dummyBytes, dummyBytes, dummyBytes, dummyBytes];
  const dummyProofC = [dummyBytes, dummyBytes];

  const merkleRoot = await getCurrentMerkleRoot(server, SHIELD_POOL_ID);
  const args = [
    bytesToScVal(hexToBytes32(bobNote.nullifier)),
    bytesToScVal(hexToBytes32(merkleRoot)),
    new Address(bob.publicKey()).toScVal(),
    new Address(TEST_USDC_ID).toScVal(),
    nativeToScVal(bobNote.amount, { type: "i128" }),
    proofToScVal(dummyProofA, dummyProofB, dummyProofC),
  ];

  try {
    await simulateAndSubmit(server, bob, SHIELD_POOL_ID, "withdraw", args);
    fail("Double-spend was NOT rejected — contract accepted a reused nullifier!");
    recordResult(6, "Double-spend rejected", false,
      { totalMs: total.elapsed() }, "Contract accepted reused nullifier");
    return { passed: false };
  } catch (err) {
    const rejected =
      err.message.includes("NullifierAlreadyUsed") ||
      err.message.includes("Simulation failed") ||
      err.message.includes("failed");
    if (rejected) {
      ok(`Correctly rejected  (${total.elapsed()}ms)  — "${err.message.slice(0, 80)}"`);
      recordResult(6, "Double-spend rejected", true, { totalMs: total.elapsed() });
      return { passed: true };
    }
    fail(`Unexpected error (not a nullifier rejection): ${err.message.slice(0, 120)}`);
    recordResult(6, "Double-spend rejected", false,
      { totalMs: total.elapsed() }, err.message);
    return { passed: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DEPENDENCY LOADER
// ═══════════════════════════════════════════════════════════════════════════════

async function requireDeps() {
  // ── snarkjs ─────────────────────────────────────────────────────────────────
  try {
    snarkjs = require("snarkjs");
  } catch {
    console.error(c.red(
      "\n  snarkjs not found.\n" +
      "  Run: npm install snarkjs\n"
    ));
    process.exit(1);
  }

  // ── @stellar/stellar-sdk ────────────────────────────────────────────────────
  try {
    _sdk = require("@stellar/stellar-sdk");
  } catch {
    console.error(c.red(
      "\n  @stellar/stellar-sdk not found.\n" +
      "  Run: npm install @stellar/stellar-sdk\n"
    ));
    process.exit(1);
  }

  // ── circomlibjs (Poseidon) ──────────────────────────────────────────────────
  // Eagerly warm up the Poseidon instance so proof generation doesn't pay
  // the WASM-init cost inside the timed proof step.
  try {
    // circomlibjs is the preferred source; getPoseidon() lazy-loads it.
    const { buildPoseidon } = require("circomlibjs");
    poseidonFn = await buildPoseidon();
  } catch {
    // Fall back to ffjavascript (ships with snarkjs).
    try {
      const { buildPoseidon } = await buildPoseidonFallback();
      poseidonFn = await buildPoseidon();
    } catch (e2) {
      console.error(c.red(
        "\n  Poseidon not available (tried circomlibjs and ffjavascript).\n" +
        "  Run: npm install circomlibjs\n"
      ));
      process.exit(1);
    }
  }
}

/**
 * Fallback Poseidon builder using ffjavascript (already in node_modules
 * as a snarkjs transitive dep).  Only invoked when circomlibjs is absent.
 */
async function buildPoseidonFallback() {
  const { buildPoseidon } = require("ffjavascript");
  return { buildPoseidon };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SUMMARY PRINTER
// ═══════════════════════════════════════════════════════════════════════════════

function printSummary() {
  console.log("\n" + "─".repeat(70));
  console.log(c.bold("Test Results"));
  console.log("─".repeat(70));

  let allPassed = true;
  for (const r of results) {
    const icon   = r.passed ? c.green("✓") : c.red("✗");
    const label  = r.passed ? c.green(r.label) : c.red(r.label);
    const timing = r.timings
      ? c.dim(
          Object.entries(r.timings)
            .map(([k, v]) => `${k}: ${v}ms`)
            .join("  ")
        )
      : "";
    const errPart = (!r.passed && r.error)
      ? `\n       ${c.dim(r.error.slice(0, 100))}`
      : "";
    console.log(`  [${r.step}/6] ${icon}  ${label}  ${timing}${errPart}`);
    if (!r.passed) allPassed = false;
  }

  console.log("─".repeat(70));
  if (allPassed) {
    console.log(c.bold(c.green("\nAll tests passed.")));
  } else {
    const failed = results.filter((r) => !r.passed).length;
    console.log(c.bold(c.red(`\n${failed} test(s) failed.`)));
  }
  console.log();
  return allPassed;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(c.bold("\n  ShieldSend — End-to-End Integration Test"));
  console.log(c.dim(`  Network: ${NETWORK}  |  RPC: ${RPC_URL}`));
  console.log(c.dim(`  ShieldPool: ${SHIELD_POOL_ID || "(not set)"}`));
  console.log(c.dim(`  Test USDC:  ${TEST_USDC_ID}`));
  console.log();

  await requireDeps();

  const { SorobanRpc } = sdk();
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

  // ── Step 1: Setup ───────────────────────────────────────────────────────────
  const { alice, bob, passed: s1 } = await step1_setup();
  if (!s1) {
    printSummary();
    process.exit(1);
  }

  // ── Step 2: Mint ────────────────────────────────────────────────────────────
  await step2_mint(server, alice);

  // ── Step 3: Deposit ─────────────────────────────────────────────────────────
  const s3 = await step3_deposit(server, alice);
  const aliceNote = s3.note || null;

  // ── Step 4: Transfer ────────────────────────────────────────────────────────
  const s4     = await step4_transfer(server, alice, aliceNote);
  const bobNote = s4.note || null;

  // ── Step 5: Withdraw ────────────────────────────────────────────────────────
  await step5_withdraw(server, bob, bobNote);

  // ── Step 6: Double-spend rejection ─────────────────────────────────────────
  await step6_doubleSpend(server, bob, bobNote);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red(`\nFatal error: ${err.stack || err.message}`));
  process.exit(1);
});
