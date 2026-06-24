/**
 * lib/stellar.ts
 * Stellar / Soroban integration layer for ShieldSend.
 * Dep: @stellar/stellar-sdk
 */

import {
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

const IS_MAINNET = process.env.STELLAR_NETWORK === "mainnet";

const HORIZON_URL = IS_MAINNET
  ? "https://horizon.stellar.org"
  : "https://horizon-testnet.stellar.org";

const RPC_URL = IS_MAINNET
  ? "https://soroban.stellar.org"
  : "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;

const SHIELD_POOL_CONTRACT_ID = process.env.NEXT_PUBLIC_SHIELD_POOL_CONTRACT_ID!;
const ASP_CONTRACT_ID = process.env.NEXT_PUBLIC_ASP_CONTRACT_ID!;

// Depth-20 Poseidon zero values (precomputed for empty subtrees)
const ZEROS: string[] = Array.from({ length: 20 }, (_, i) =>
  // placeholder: real values come from the circuit's zero_value constants
  `0x${BigInt(i).toString(16).padStart(64, "0")}`
);

const BASE_FEE = "1000000"; // generous for proof verification compute

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StellarTxResult {
  success: boolean;
  txHash: string;
  error?: string;
}

interface SorobanProofArgs {
  a: [Uint8Array, Uint8Array];
  b: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  c: [Uint8Array, Uint8Array];
}

// ─── Server ───────────────────────────────────────────────────────────────────

/** Returns a configured Soroban RPC server instance. */
export function getServer(): SorobanRpc.Server {
  return new SorobanRpc.Server(RPC_URL, { allowHttp: false });
}

// ─── Contract client ──────────────────────────────────────────────────────────

/** Returns a Contract instance for the given contract ID. */
export async function getContractClient(
  contractId: string,
  _sourcePublicKey: string
): Promise<Contract> {
  return new Contract(contractId);
}

// ─── ScVal helpers ────────────────────────────────────────────────────────────

function bytesToScVal(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function proofToScVal(proof: SorobanProofArgs): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("a"),
      val: xdr.ScVal.scvVec(proof.a.map(bytesToScVal)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("b"),
      val: xdr.ScVal.scvVec(proof.b.map(bytesToScVal)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c"),
      val: xdr.ScVal.scvVec(proof.c.map(bytesToScVal)),
    }),
  ]);
}

// ─── Tx submit helper ─────────────────────────────────────────────────────────

async function simulateAndSubmit(
  server: SorobanRpc.Server,
  keypair: Keypair,
  callArgs: xdr.ScVal[],
  method: string,
  contractId: string
): Promise<StellarTxResult> {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...callArgs))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    return { success: false, txHash: "", error: simResult.error };
  }

  const prepared = SorobanRpc.assembleTransaction(tx, simResult).build();
  prepared.sign(keypair);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    return { success: false, txHash: sendResult.hash, error: "Transaction rejected by network" };
  }

  // Poll for confirmation
  let getResult: SorobanRpc.Api.GetTransactionResponse;
  do {
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await server.getTransaction(sendResult.hash);
  } while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND);

  const success = getResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS;
  return {
    success,
    txHash: sendResult.hash,
    error: success ? undefined : `Transaction failed: ${getResult.status}`,
  };
}

// ─── Pool operations ──────────────────────────────────────────────────────────

/** Deposit into the ShieldSend pool. */
export async function depositToPool(params: {
  sourceKeypair: Keypair;
  assetContractId: string;
  amount: bigint;
  commitment: Uint8Array;
  proof: SorobanProofArgs;
}): Promise<StellarTxResult> {
  const server = getServer();
  return simulateAndSubmit(
    server,
    params.sourceKeypair,
    [
      new Address(params.assetContractId).toScVal(),
      nativeToScVal(params.amount, { type: "i128" }),
      bytesToScVal(params.commitment),
      proofToScVal(params.proof),
    ],
    "deposit",
    SHIELD_POOL_CONTRACT_ID
  );
}

/** Execute a private transfer inside the pool. */
export async function transferInPool(params: {
  sourceKeypair: Keypair;
  nullifier: Uint8Array;
  newCommitment: Uint8Array;
  merkleRoot: Uint8Array;
  assetId: Uint8Array;
  proof: SorobanProofArgs;
}): Promise<StellarTxResult> {
  const server = getServer();
  return simulateAndSubmit(
    server,
    params.sourceKeypair,
    [
      bytesToScVal(params.nullifier),
      bytesToScVal(params.newCommitment),
      bytesToScVal(params.merkleRoot),
      bytesToScVal(params.assetId),
      proofToScVal(params.proof),
    ],
    "transfer",
    SHIELD_POOL_CONTRACT_ID
  );
}

/** Withdraw from the pool to a Stellar address. */
export async function withdrawFromPool(params: {
  sourceKeypair: Keypair;
  nullifier: Uint8Array;
  merkleRoot: Uint8Array;
  recipient: string;
  assetContractId: string;
  amount: bigint;
  proof: SorobanProofArgs;
}): Promise<StellarTxResult> {
  const server = getServer();
  return simulateAndSubmit(
    server,
    params.sourceKeypair,
    [
      bytesToScVal(params.nullifier),
      bytesToScVal(params.merkleRoot),
      new Address(params.recipient).toScVal(),
      new Address(params.assetContractId).toScVal(),
      nativeToScVal(params.amount, { type: "i128" }),
      proofToScVal(params.proof),
    ],
    "withdraw",
    SHIELD_POOL_CONTRACT_ID
  );
}

// ─── Contract state reads ─────────────────────────────────────────────────────

/** Read the current Merkle root from contract storage. */
export async function getCurrentMerkleRoot(): Promise<string> {
  const server = getServer();
  const contract = new Contract(SHIELD_POOL_CONTRACT_ID);
  const key = xdr.ScVal.scvSymbol("MerkleRoot");
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const result = await server.getLedgerEntries(ledgerKey);
  if (!result.entries.length) throw new Error("MerkleRoot not found in contract storage");
  const val = scValToNative(result.entries[0].val.contractData().val()) as bigint;
  return "0x" + val.toString(16).padStart(64, "0");
}

/** Build the 20-element Merkle path for a given leaf index. */
export async function getMerklePath(
  leafIndex: number
): Promise<{ path: string[]; indices: number[] }> {
  const server = getServer();
  const contract = new Contract(SHIELD_POOL_CONTRACT_ID);

  const path: string[] = [];
  const indices: number[] = [];
  let index = leafIndex;

  const keys: xdr.LedgerKey[] = [];
  const levelIndex: [number, number][] = [];

  for (let level = 0; level < 20; level++) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    indices.push(index % 2);
    levelIndex.push([level, siblingIndex]);

    const storageKey = xdr.ScVal.scvSymbol(`NODE_${level}_${siblingIndex}`);
    keys.push(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contract.address().toScAddress(),
          key: storageKey,
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    );
    index = Math.floor(index / 2);
  }

  // Batch fetch all sibling nodes
  const result = await server.getLedgerEntries(...keys);
  const found = new Map(
    result.entries.map((e) => {
      const sym = e.val.contractData().key().sym();
      const val = scValToNative(e.val.contractData().val()) as bigint;
      return [sym, "0x" + val.toString(16).padStart(64, "0")];
    })
  );

  for (let level = 0; level < 20; level++) {
    const [lvl, sibIdx] = levelIndex[level];
    const key = `NODE_${lvl}_${sibIdx}`;
    path.push(found.get(key) ?? ZEROS[level]);
  }

  return { path, indices };
}

/** Check whether a nullifier has already been spent. */
export async function getNullifierStatus(nullifier: string): Promise<boolean> {
  const server = getServer();
  const contract = new Contract(SHIELD_POOL_CONTRACT_ID);
  const hex = nullifier.startsWith("0x") ? nullifier.slice(2) : nullifier;
  const key = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("Nullifier"),
      val: xdr.ScVal.scvBytes(Buffer.from(hex, "hex")),
    }),
  ]);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const result = await server.getLedgerEntries(ledgerKey);
  return result.entries.length > 0;
}

// ─── Event polling ────────────────────────────────────────────────────────────

type EventCallback = (event: { type: string; data: Record<string, string> }) => void;

/**
 * Poll Horizon for ShieldPool contract events every 5 seconds.
 * Returns a cleanup function that stops polling.
 */
export async function watchEvents(
  since: number,
  onEvent: EventCallback
): Promise<() => void> {
  let cursor = since.toString();
  let active = true;

  const poll = async () => {
    try {
      const url =
        `${HORIZON_URL}/contracts/${SHIELD_POOL_CONTRACT_ID}/events` +
        `?cursor=${cursor}&limit=20&order=asc`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as {
        _embedded: { records: Array<{ id: string; type: string; value: { xdr: string } }> };
      };
      for (const record of json._embedded.records) {
        cursor = record.id;
        const val = scValToNative(xdr.ScVal.fromXDR(record.value.xdr, "base64")) as Record<string, string>;
        onEvent({ type: record.type, data: val });
      }
    } catch {
      // Ignore transient errors; next tick will retry
    }
  };

  const interval = setInterval(() => { if (active) poll(); }, 5000);
  poll(); // immediate first fetch

  return () => {
    active = false;
    clearInterval(interval);
  };
}
