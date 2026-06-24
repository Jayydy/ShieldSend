/**
 * lib/proof.ts
 * Groth16 proof generation wrapper for ShieldSend.
 * Deps: snarkjs (dynamic import), fetch (native), WebCrypto (native)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DepositInputs {
  commitment: string;
  amount: string;
  assetId: string;
  secret: string;
  recipientPubkey: string;
}

export interface TransferInputs {
  nullifier: string;
  newCommitment: string;
  merkleRoot: string;
  assetId: string;
  secret: string;
  amount: string;
  leafIndex: string;
  merklePath: string[];           // 20 elements
  merklePathIndices: string[];    // 20 elements, "0" | "1"
  recipientPubkeyNew: string;
  newSecret: string;
  senderPubkey: string;
}

export interface WithdrawInputs {
  nullifier: string;
  merkleRoot: string;
  recipient: string;
  amount: string;
  assetId: string;
  secret: string;
  leafIndex: string;
  merklePath: string[];
  merklePathIndices: string[];
  recipientPubkey: string;
}

export interface GrothProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  publicSignals: string[];
}

export interface SorobanProof {
  proofA: [Uint8Array, Uint8Array];
  proofB: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  proofC: [Uint8Array, Uint8Array];
}

// ─── Circuit file cache ───────────────────────────────────────────────────────

type CircuitName = "deposit" | "transfer" | "withdraw";

const fileCache = new Map<string, ArrayBuffer>();

async function fetchCircuitFile(path: string): Promise<ArrayBuffer> {
  const cached = fileCache.get(path);
  if (cached) return cached;

  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load circuit file: ${path} (${res.status})`);

  const buf = await res.arrayBuffer();
  fileCache.set(path, buf);
  return buf;
}

async function loadCircuit(name: CircuitName): Promise<[ArrayBuffer, ArrayBuffer]> {
  return Promise.all([
    fetchCircuitFile(`/circuits/${name}.wasm`),
    fetchCircuitFile(`/circuits/${name}_final.zkey`),
  ]);
}

// ─── Core prove helper ────────────────────────────────────────────────────────

type CircuitInputs = DepositInputs | TransferInputs | WithdrawInputs;

async function prove(name: CircuitName, inputs: CircuitInputs): Promise<GrothProof> {
  const [wasm, zkey] = await loadCircuit(name);
  const snarkjs = await import("snarkjs");

  const timeoutMs = 30_000;
  const proofPromise = snarkjs.groth16.fullProve(
    inputs,
    new Uint8Array(wasm),
    new Uint8Array(zkey)
  );

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Proof generation timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const { proof, publicSignals } = await Promise.race([proofPromise, timeout]);

  return {
    a: [proof.pi_a[0] as string, proof.pi_a[1] as string],
    b: [
      [proof.pi_b[0][1] as string, proof.pi_b[0][0] as string], // G2 point: swap for Groth16 convention
      [proof.pi_b[1][1] as string, proof.pi_b[1][0] as string],
    ],
    c: [proof.pi_c[0] as string, proof.pi_c[1] as string],
    publicSignals: publicSignals as string[],
  };
}

// ─── Public proof generators ──────────────────────────────────────────────────

/** Generate a Groth16 deposit proof. Proof time ~1.5–4s depending on device. */
export async function generateDepositProof(inputs: DepositInputs): Promise<GrothProof> {
  return prove("deposit", inputs);
}

/** Generate a Groth16 transfer proof (Merkle inclusion + nullifier + output). */
export async function generateTransferProof(inputs: TransferInputs): Promise<GrothProof> {
  if (inputs.merklePath.length !== 20 || inputs.merklePathIndices.length !== 20) {
    throw new Error("merklePath and merklePathIndices must each have exactly 20 elements");
  }
  return prove("transfer", inputs);
}

/** Generate a Groth16 withdrawal proof linking recipient address to note. */
export async function generateWithdrawProof(inputs: WithdrawInputs): Promise<GrothProof> {
  if (inputs.merklePath.length !== 20 || inputs.merklePathIndices.length !== 20) {
    throw new Error("merklePath and merklePathIndices must each have exactly 20 elements");
  }
  return prove("withdraw", inputs);
}

// ─── Soroban formatting ───────────────────────────────────────────────────────

function bigIntToBytes32(value: string): Uint8Array {
  const hex = BigInt(value).toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Convert a GrothProof to the BytesN<32> tuple format expected by the
 * ShieldPool Soroban contract.
 */
export function formatProofForSoroban(proof: GrothProof): SorobanProof {
  return {
    proofA: [bigIntToBytes32(proof.a[0]), bigIntToBytes32(proof.a[1])],
    proofB: [
      bigIntToBytes32(proof.b[0][0]),
      bigIntToBytes32(proof.b[0][1]),
      bigIntToBytes32(proof.b[1][0]),
      bigIntToBytes32(proof.b[1][1]),
    ],
    proofC: [bigIntToBytes32(proof.c[0]), bigIntToBytes32(proof.c[1])],
  };
}

// ─── UX utility ──────────────────────────────────────────────────────────────

/**
 * Estimate proof generation time in milliseconds based on CPU core count.
 * Calibration: 1 core ≈ 4000ms, 8 cores ≈ 1200ms (linear interpolation).
 */
export function estimateProofTime(): number {
  const cores = navigator.hardwareConcurrency ?? 1;
  const clamped = Math.max(1, Math.min(cores, 8));
  // Linear: f(1)=4000, f(8)=1200 → slope = (1200-4000)/(8-1)
  return Math.round(4000 + ((1200 - 4000) / 7) * (clamped - 1));
}
