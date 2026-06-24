/**
 * lib/note.ts
 * ZK payment note management for ShieldSend.
 * Deps: poseidon-lite, @stellar/stellar-sdk, WebCrypto (native)
 */

import { poseidon2, poseidon4 } from "poseidon-lite";
import { StrKey } from "@stellar/stellar-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  secret: string;           // 0x-prefixed hex, 252-bit field element
  amount: bigint;
  assetId: string;          // 0x-prefixed hex bytes32
  recipientPubkey: string;  // 0x-prefixed hex bytes32
  leafIndex: number;
  commitment: string;       // 0x-prefixed hex bytes32
  nullifier: string;        // 0x-prefixed hex bytes32
  spent: boolean;
  createdAt: number;
  memo?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// BN254 scalar field prime
const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const STORAGE_KEY = "shieldsend:notes";
const HKDF_SALT = new TextEncoder().encode("shieldsend-notes-v1");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toHex32(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex.startsWith("0x") ? hex : "0x" + hex);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

// ─── Secret generation ────────────────────────────────────────────────────────

/** Generate a 252-bit CSPRNG secret as a 0x-prefixed hex string. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Mask top nibble to stay < 2^252 (and well within BN254 field)
  bytes[0] &= 0x0f;
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Field conversions ────────────────────────────────────────────────────────

/** Convert a Stellar G... public key to a BN254 field element. */
export async function stellarPubkeyToField(pubkey: string): Promise<bigint> {
  const raw = StrKey.decodeEd25519PublicKey(pubkey); // 32 bytes
  const hash = await sha256(raw);
  return BigInt("0x" + Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("")) % FIELD_PRIME;
}

/** Hash asset code + issuer to a BN254 field element. */
export async function assetToField(code: string, issuer: string): Promise<bigint> {
  const data = new TextEncoder().encode(`${code}:${issuer}`);
  const hash = await sha256(data);
  return BigInt("0x" + Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("")) % FIELD_PRIME;
}

// ─── Commitment / nullifier ───────────────────────────────────────────────────

/** Poseidon4(secret, amount, assetId, recipientPubkey) → 0x hex bytes32 */
export async function computeCommitment(
  secret: string,
  amount: bigint,
  assetId: bigint,
  recipientPubkey: bigint
): Promise<string> {
  const result = poseidon4([hexToBigInt(secret), amount, assetId, recipientPubkey]);
  return toHex32(result);
}

/** Poseidon2(secret, leafIndex) → 0x hex bytes32 */
export async function computeNullifier(secret: string, leafIndex: number): Promise<string> {
  const result = poseidon2([hexToBigInt(secret), BigInt(leafIndex)]);
  return toHex32(result);
}

// ─── Note factory ─────────────────────────────────────────────────────────────

export async function createNote(
  params: Omit<Note, "id" | "commitment" | "nullifier" | "createdAt">
): Promise<Note> {
  const assetIdBig = hexToBigInt(params.assetId);
  const recipientBig = hexToBigInt(params.recipientPubkey);

  const [commitment, nullifier] = await Promise.all([
    computeCommitment(params.secret, params.amount, assetIdBig, recipientBig),
    computeNullifier(params.secret, params.leafIndex),
  ]);

  return {
    ...params,
    id: crypto.randomUUID(),
    commitment,
    nullifier,
    createdAt: Date.now(),
  };
}

// ─── Encrypted localStorage persistence ──────────────────────────────────────

/**
 * Derive an AES-GCM CryptoKey from the user's Stellar secret key via HKDF-SHA256.
 * The Stellar secret is the IKM; "shieldsend-notes-v1" is the salt.
 */
export async function deriveStorageKey(stellarSecret: string): Promise<CryptoKey> {
  const raw = StrKey.decodeEd25519SecretSeed(stellarSecret); // 32 bytes
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: new Uint8Array() },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** AES-GCM encrypt a UTF-8 string. Returns base64(iv || ciphertext). */
async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...combined));
}

/** AES-GCM decrypt a base64(iv || ciphertext) blob. */
async function decrypt(key: CryptoKey, blob: string): Promise<string> {
  const combined = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// Serialise bigint-containing Note to/from JSON
function serialise(notes: Note[]): string {
  return JSON.stringify(notes, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
}

function deserialise(json: string): Note[] {
  return JSON.parse(json, (_k, v) => {
    if (typeof v === "string" && /^\d+n$/.test(v)) return BigInt(v.slice(0, -1));
    return v;
  });
}

/** Encrypt and persist a note to localStorage. */
export async function saveNote(note: Note, key: CryptoKey): Promise<void> {
  const existing = await loadNotes(key);
  const updated = [...existing.filter((n) => n.id !== note.id), note];
  localStorage.setItem(STORAGE_KEY, await encrypt(key, serialise(updated)));
}

/** Load and decrypt all notes from localStorage. Returns [] on missing/error. */
export async function loadNotes(key: CryptoKey): Promise<Note[]> {
  const blob = localStorage.getItem(STORAGE_KEY);
  if (!blob) return [];
  try {
    return deserialise(await decrypt(key, blob));
  } catch {
    return [];
  }
}

/** Mark a note as spent by commitment hash. */
export async function markSpent(commitment: string, key: CryptoKey): Promise<void> {
  const notes = await loadNotes(key);
  const note = notes.find((n) => n.commitment === commitment);
  if (!note) return;
  await saveNote({ ...note, spent: true }, key);
}

/** Encode a note as a base64 string for copy/paste sharing. */
export function noteToString(note: Note): string {
  return btoa(JSON.stringify(note, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v)));
}

/** Parse a note from a base64 string or raw JSON string. Throws on invalid input. */
export function loadFromString(input: string): Note {
  try {
    const json = input.trim().startsWith("{") ? input.trim() : atob(input.trim());
    return JSON.parse(json, (_k, v) => {
      if (typeof v === "string" && /^\d+n$/.test(v)) return BigInt(v.slice(0, -1));
      return v;
    }) as Note;
  } catch {
    throw new Error("Invalid note string. Paste the full note string or upload the JSON file.");
  }
}
