
<div align="center">

<img src="https://img.shields.io/badge/Stellar-Protocol%2025-7B61FF?style=for-the-badge&logo=stellar&logoColor=white" />
<img src="https://img.shields.io/badge/ZK-Groth16%20%2B%20Circom%202-00E5C4?style=for-the-badge" />
<img src="https://img.shields.io/badge/Soroban-Rust-F74C00?style=for-the-badge&logo=rust&logoColor=white" />
<img src="https://img.shields.io/badge/Status-Hackathon%20Build-FFB800?style=for-the-badge" />
<img src="https://img.shields.io/badge/Network-Stellar%20Testnet-0B0F1A?style=for-the-badge" />

<br /><br />

```
 ____  _     _      _     _ ____                _
/ ___|| |__ (_) ___| | __| / ___|  ___ _ __   __| |
\___ \| '_ \| |/ _ \ |/ _` \___ \ / _ \ '_ \ / _` |
 ___) | | | | |  __/ | (_| |___) |  __/ | | | (_| |
|____/|_| |_|_|\___|_|\__,_|____/ \___|_| |_|\__,_|
```

### **Send money across borders. Prove it arrived. Tell no one how much.**

*ZK-powered private cross-border remittances on Stellar — built for the Stellar Hacks: Real-World ZK Hackathon*

<br />

[**Live Demo**](https://shieldsend.vercel.app) · [**Demo Video**](https://youtu.be/shieldsend-demo) · [**Testnet Explorer**](https://stellar.expert/explorer/testnet) · [**Hackathon Submission**](https://dorahacks.io/hackathon/stellar-hacks-zk)

</div>

---

## Table of Contents

- [The Problem](#the-problem)
- [What ShieldSend Does](#what-shieldsend-does)
- [How the ZK Works](#how-the-zk-works)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
- [Contract Addresses](#contract-addresses)
- [Security Model](#security-model)
- [Known Limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Team](#team)
- [License](#license)

---

## The Problem

People sending money internationally face two bad options today.

**Centralized rails** (Western Union, Wise, SWIFT) charge 3–7% per transfer, take 1–5 business days, and require full KYC that exposes sender and recipient data to multiple intermediaries.

**Transparent blockchains** (Stellar native, Ethereum) are fast and cheap — but every transfer amount, sender address, and recipient address is permanently public. For remittance use cases in politically sensitive regions, or simply for basic financial privacy, this is a dealbreaker.

ShieldSend solves this using zero-knowledge proofs: transfers settle on Stellar in under 5 seconds, but the amount and the link between sender and recipient are hidden by cryptographic proof — not by trust in a third party.

---

## What ShieldSend Does

ShieldSend operates on a **note-based private payment model**:

1. **Deposit** — You deposit USDC into the ShieldSend pool contract. You receive a private *note* (a secret key) stored only in your browser. The deposit amount IS visible on-chain, because Stellar requires a real token transfer — but it's unlinked from any future transfer.

2. **Transfer** — You prove ownership of your note using a zero-knowledge proof, spend it, and create a new note for your recipient. **No amount appears on-chain. No address link is created.** The Stellar ledger records only that a valid proof was submitted and a new commitment was added to the pool.

3. **Withdraw** — The recipient proves ownership of their note and withdraws to any Stellar address. The recipient address and amount are revealed at this point — but they cannot be linked back to the original depositor.

```
Alice deposits 100 USDC        Bob withdraws 100 USDC
        │                               │
        ▼                               ▼
  ┌─────────────────────────────────────────────┐
  │           ShieldSend Pool                   │
  │                                             │
  │  commitment_A ──[ZK Transfer]──▶ commitment_B│
  │                                             │
  │  "Valid proof. Note spent. New note added." │
  │  (amount: hidden, link: hidden)             │
  └─────────────────────────────────────────────┘

On-chain record:
  Deposit:  Alice → Pool: 100 USDC  ✓ (visible)
  Transfer: nullifier_A spent, commitment_B created  ✓ (amount hidden)
  Withdraw: Pool → Bob: 100 USDC  ✓ (visible, but unlinked from Alice)
```

---

## How the ZK Works

### Core Primitives

Every note is a **commitment** — a Poseidon hash of the note's private data:

```
commitment = Poseidon(secret, amount, asset_id, recipient_pubkey)
nullifier  = Poseidon(secret, leaf_index)
```

The pool maintains an **append-only Merkle tree** of commitments (depth 20, ~1M capacity). Spending a note requires a Groth16 proof that:

1. **Ownership** — You know the `secret` behind a commitment that exists in the Merkle tree
2. **No double-spend** — The `nullifier` derived from your secret and leaf index hasn't been used before
3. **Conservation** — The output note carries the same amount as the input note

### Why ZK is load-bearing here (not decorative)

Without ZK, there is no privacy. A naive shielded pool without proofs would allow anyone to insert false notes or spend commitments they don't own. The ZK proof is what allows the contract to *verify correctness without seeing the private inputs*. The privacy and the integrity are inseparable.

### Stellar Protocol 25 advantage

Stellar's Protocol 25 (X-Ray) upgrade added **native BN254 elliptic curve operations** as host functions — `bn254_add`, `bn254_scalar_mul`, `bn254_pairing` — plus native **Poseidon and Poseidon2 hash functions**. This makes Groth16 proof verification and Merkle tree operations dramatically cheaper on Soroban compared to earlier protocols, and was the direct enabler for building a viable ZK payment system on Stellar without an L2.

### Circuits

| Circuit | Constraints | Purpose |
|---------|-------------|---------|
| `deposit.circom` | ~50,000 | Proves commitment is correctly formed |
| `transfer.circom` | ~200,000 | Proves note ownership + Merkle inclusion + nullifier validity + output commitment construction |
| `withdraw.circom` | ~150,000 | Proves ownership + links recipient address to note |

Proofs are generated **client-side in the browser** using snarkjs + WASM. Typical proof time: 1.5–4 seconds depending on device.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     BROWSER (Next.js 14)                     │
│                                                              │
│  ┌──────────────┐   ┌───────────────┐   ┌────────────────┐  │
│  │  Deposit UI  │   │  Transfer UI  │   │  Withdraw UI   │  │
│  └──────┬───────┘   └───────┬───────┘   └───────┬────────┘  │
│         │                   │                   │            │
│  ┌──────▼───────────────────▼───────────────────▼────────┐  │
│  │              Proof Generator  (snarkjs WASM)           │  │
│  │    deposit.circom │ transfer.circom │ withdraw.circom   │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │  Groth16 proof + public inputs │
└─────────────────────────────┼────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                 STELLAR TESTNET (Soroban)                     │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   ShieldPool Contract                  │  │
│  │                                                       │  │
│  │  groth16_verify()  ← BN254 native host functions      │  │
│  │  commitment_tree   ← Poseidon2 Merkle (depth 20)      │  │
│  │  nullifier_set     ← Map<BytesN<32>, bool>            │  │
│  │                                                       │  │
│  │  deposit()  /  transfer()  /  withdraw()              │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │                                │
│  ┌──────────────────────────▼────────────────────────────┐  │
│  │              ASP Compliance Contract                   │  │
│  │                                                       │  │
│  │  allowlist_tree  ← Poseidon Merkle                    │  │
│  │  blocklist_tree  ← Poseidon Merkle                    │  │
│  │  is_eligible()   ← on-chain Merkle verification       │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Groth16 over PLONK** — Groth16 has smaller proofs (3 group elements) and cheaper on-chain verification. The trusted setup tradeoff is acceptable for a hackathon demo; a production system would run a multi-party ceremony.
- **Poseidon over Keccak/SHA256** — Poseidon is ZK-friendly (SNARK-native), far cheaper in constraints than SHA256, and now natively supported by Protocol 25.
- **Client-side proof generation** — No trusted prover server. Users' secrets never leave their browser.
- **Append-only Merkle tree** — Old roots remain valid for a configurable window (30 historical roots), so proofs generated against a slightly stale root still work after concurrent transactions.

---

## Repository Structure

```
shieldsend/
├── circuits/
│   ├── merkle.circom              # Reusable Poseidon Merkle proof library
│   ├── deposit.circom             # Deposit note commitment circuit
│   ├── transfer.circom            # Private transfer circuit (core)
│   ├── withdraw.circom            # Withdrawal proof circuit
│   └── poseidon/                  # circomlib Poseidon constants
│
├── contracts/
│   ├── shield_pool/
│   │   ├── src/
│   │   │   ├── lib.rs             # Main ShieldPool contract
│   │   │   ├── verifier.rs        # Groth16 verifier (BN254)
│   │   │   ├── merkle.rs          # On-chain Poseidon Merkle tree
│   │   │   └── vk_constants.rs    # Embedded verification keys (generated)
│   │   └── Cargo.toml
│   └── asp/
│       ├── src/lib.rs             # ASP compliance contract
│       └── Cargo.toml
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx               # Landing page + note dashboard
│   │   ├── deposit/page.tsx       # Deposit flow
│   │   ├── transfer/page.tsx      # Private transfer flow
│   │   └── withdraw/page.tsx      # Withdrawal flow
│   ├── lib/
│   │   ├── note.ts                # Note creation, storage, encryption
│   │   ├── proof.ts               # snarkjs proof generation wrapper
│   │   ├── stellar.ts             # Stellar SDK + Soroban integration
│   │   └── merkle.ts              # Off-chain Merkle state sync
│   └── public/
│       └── circuits/              # Compiled .wasm + .zkey files
│
├── scripts/
│   ├── compile-circuits.sh        # circom compile + snarkjs trusted setup
│   ├── extract-vk.js              # Exports VK constants to Rust
│   ├── deploy-contracts.sh        # Soroban deploy to testnet
│   └── e2e-test.js                # Full deposit → transfer → withdraw test
│
├── build/                         # Circuit compilation output (gitignored)
├── .env.example
└── README.md
```

---

## Quick Start

**Prerequisites**

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| circom | 2.x | `npm install -g circom` |
| snarkjs | latest | `npm install -g snarkjs` |
| soroban-cli | 21.x | `cargo install --locked soroban-cli` |
| Freighter | browser ext | [freighter.app](https://freighter.app) |

**30-second demo (using deployed testnet contracts)**

```bash
git clone https://github.com/demigodjayydy/shieldsend
cd shieldsend/frontend

cp .env.example .env.local
# .env.example already contains the deployed testnet contract IDs

npm install
npm run dev
# → http://localhost:3000
```

Connect Freighter to Stellar Testnet, fund your wallet from the [Friendbot](https://friendbot.stellar.org), and you're ready to deposit.

---

## Detailed Setup

### 1. Compile circuits

> Skip this if you're using the pre-compiled circuits in `frontend/public/circuits/`. They're committed for convenience.

```bash
# Download Hermez Powers of Tau (one-time, ~700MB)
mkdir -p ptau
curl -L https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_20.ptau \
  -o ptau/pot20_final.ptau

# Compile all three circuits + run trusted setup
chmod +x scripts/compile-circuits.sh
./scripts/compile-circuits.sh

# Extract verification keys to Rust constants
node scripts/extract-vk.js
```

Expected output:
```
[deposit]   constraints: 51,247   ✓
[transfer]  constraints: 198,334  ✓
[withdraw]  constraints: 147,891  ✓
Verification keys written to contracts/shield_pool/src/vk_constants.rs
```

### 2. Build and deploy contracts

```bash
export DEPLOYER_SECRET="S..."    # your Stellar testnet secret key
export STELLAR_NETWORK="testnet"

chmod +x scripts/deploy-contracts.sh
./scripts/deploy-contracts.sh

# Contract IDs are written to frontend/.env.local automatically
```

### 3. Run the frontend

```bash
cd frontend
npm install
npm run dev
```

### 4. Run integration tests

```bash
export DEPLOYER_SECRET="S..."
export SHIELD_POOL_CONTRACT_ID="C..."
export ASP_CONTRACT_ID="C..."

node scripts/e2e-test.js
```

Expected output:
```
[1/6] Setup: Alice and Bob keypairs funded         ✓  (2.1s)
[2/6] Alice mints 100 USDC                         ✓  (1.8s)
[3/6] Alice deposits to pool                       ✓  proof: 2.3s  tx: 4.1s
[4/6] Alice transfers note to Bob                  ✓  proof: 3.7s  tx: 3.9s
[5/6] Bob withdraws to address                     ✓  proof: 2.8s  tx: 4.2s
[6/6] Double-spend rejected (NullifierAlreadyUsed) ✓  (0.3s)

All tests passed.
```

---

## Contract Addresses

### Stellar Testnet

| Contract | Address |
|----------|---------|
| ShieldPool | `CSHIELDPOOL...` |
| ASP (Compliance) | `CASP...` |
| Test USDC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

> Mainnet contracts are not deployed. ShieldSend is a hackathon project.

---

## Security Model

### What's cryptographically secure

- **Note privacy** — The link between depositor and recipient is broken by ZK. Even the ShieldSend deployer cannot correlate deposits and withdrawals.
- **No double-spend** — The nullifier mechanism is enforced by the Soroban contract. Reuse of a note is rejected at the contract level, not by trusting the client.
- **Proof soundness** — Groth16 under the BN254 curve with Hermez pot20 trusted setup. The security assumption is that at least one participant in the Hermez ceremony was honest (a reasonable assumption given 100+ participants).
- **Client-side proving** — Secrets never leave the user's browser. There is no prover server.

### What is NOT production-ready

**Trusted setup** — ShieldSend uses a single-contributor contribution on top of the Hermez ceremony. A production deployment would require a publicly auditable multi-party computation ceremony specific to this circuit.

**Note storage** — Notes are AES-GCM encrypted and stored in `localStorage`, keyed by a wallet-derived secret. If the user clears their browser storage or loses access to their Stellar secret key, notes are unrecoverable. A production system would need hardware wallet integration or a server-side encrypted backup option.

**ASP compliance (v1)** — The Association Set Provider contract uses standard on-chain Merkle membership verification, not ZK. This means allowlist membership is publicly observable to anyone who reads contract state. ZK non-membership proofs for the blocklist are planned for v2 (see Roadmap). The v1 ASP is appropriate for a permissioned/testnet setting.

**Audit status** — Unaudited. The Groth16 verifier, Soroban contracts, and Circom circuits have not been reviewed by a third party.

---

## Known Limitations

| Limitation | Impact | Planned fix |
|------------|--------|-------------|
| Notes are not splittable (v1 transfers exact amounts only) | A 100 USDC note cannot become a 70 + 30 split | v2 multi-output transfer circuit |
| Proof generation on low-end mobile devices can take 8–12s | Poor UX on budget phones | Investigate server-side proving with a privacy-preserving relay |
| ASP blocklist check is on-chain (observable) | Compliance officer can see who is checked | ZK non-membership proof in v2 |
| No note backup other than local download | Note loss = fund loss | Hardware wallet integration |
| Single asset per note | Cannot mix USDC and EURC in one transfer | Multi-asset notes in v2 |

---

## Roadmap

**v0.1 — Hackathon (current)**
- [x] Circom circuits: deposit, transfer, withdraw
- [x] Groth16 on-chain verification via BN254 native host functions
- [x] Poseidon Merkle tree in Soroban storage
- [x] ASP compliance contract (v1, on-chain Merkle)
- [x] Next.js frontend with in-browser proof generation
- [x] USDC support on Stellar Testnet

**v0.2 — Post-hackathon**
- [ ] Multi-output transfer (note splitting)
- [ ] ZK non-membership proof for ASP blocklist
- [ ] Multi-party trusted setup ceremony
- [ ] EURC and XLM support
- [ ] Mobile proof generation optimisation

**v1.0 — Production**
- [ ] Third-party security audit
- [ ] Hardware wallet note backup (Ledger)
- [ ] Server-side proving relay (opt-in, privacy-preserving)
- [ ] Multi-party ceremony with public transcript
- [ ] Mainnet deployment

---

## Contributing

ShieldSend is open source. Issues and PRs are welcome.

```bash
# Fork the repo, then:
git clone https://github.com/<your-username>/shieldsend
cd shieldsend
git checkout -b feature/your-feature
```

Please open an issue before submitting a large PR so we can discuss the approach first.

**Areas where contributions are especially welcome:**
- Circuit optimisation (reducing constraint count in transfer.circom)
- Improved Merkle path retrieval from Soroban contract storage
- Mobile proof generation performance
- Additional Stellar asset support

---

## Team

**DEMIGODJAYYDY** — builder at the intersection of ZK cryptography, Stellar blockchain infrastructure, and creative work.

*Built for the [Stellar Hacks: Real-World ZK Hackathon](https://dorahacks.io/hackathon/stellar-hacks-zk) · June 2026*

---

## References

| Resource | Link |
|----------|------|
| Stellar Private Payments PoC | [github.com/stellar/stellar-private-payments](https://github.com/stellar/stellar-private-payments) |
| Soroban Groth16 Verifier | [github.com/stellar/soroban-examples](https://github.com/stellar/soroban-examples/tree/main/groth16_verifier) |
| Circom Documentation | [docs.circom.io](https://docs.circom.io) |
| snarkjs | [github.com/iden3/snarkjs](https://github.com/iden3/snarkjs) |
| circomlib (Poseidon) | [github.com/iden3/circomlib](https://github.com/iden3/circomlib) |
| Hermez Trusted Setup | [blog.hermez.io/hermez-cryptographic-setup](https://blog.hermez.io/hermez-cryptographic-setup) |
| Stellar Protocol 25 (X-Ray) | [stellar.org/developers](https://stellar.org/developers) |
| Freighter Wallet API | [docs.freighter.app](https://docs.freighter.app) |
| Soroban SDK | [docs.rs/soroban-sdk](https://docs.rs/soroban-sdk) |

---

## License

MIT License — see [LICENSE](./LICENSE) for details.

---

<div align="center">

*"Cryptographic privacy is not about hiding wrongdoing. It is about preserving the basic human right to financial dignity."*

**ShieldSend — Stellar Hacks: Real-World ZK · 2026**

</div>
