"use client";

import { useState, useCallback, useRef } from "react";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  type Note,
  generateSecret,
  stellarPubkeyToField,
  createNote,
  saveNote,
  markSpent,
  deriveStorageKey,
  loadFromString,
  noteToString,
} from "../../lib/note";
import {
  generateTransferProof,
  formatProofForSoroban,
  estimateProofTime,
} from "../../lib/proof";
import {
  getCurrentMerkleRoot,
  getMerklePath,
  getNullifierStatus,
  transferInPool,
} from "../../lib/stellar";

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = "load_note" | "enter_recipient" | "generating_proof" | "submitting" | "complete" | "error";

// ─── Step dots ────────────────────────────────────────────────────────────────

const STEP_ORDER: Step[] = ["load_note", "enter_recipient", "generating_proof", "submitting", "complete"];

function StepDots({ current }: { current: Step }) {
  const currentIdx = STEP_ORDER.indexOf(current === "error" ? "load_note" : current);
  return (
    <div className="flex items-center gap-2 mb-8">
      {STEP_ORDER.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full transition-colors ${
              i < currentIdx
                ? "bg-[#00E5C4]"
                : i === currentIdx
                ? "bg-[#00E5C4] ring-2 ring-[#00E5C4]/30"
                : "bg-white/20"
            }`}
          />
          {i < STEP_ORDER.length - 1 && (
            <div className={`w-8 h-px ${i < currentIdx ? "bg-[#00E5C4]/50" : "bg-white/10"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Note card ────────────────────────────────────────────────────────────────

function NoteCard({ note, label, teal = false }: { note: Note; label: string; teal?: boolean }) {
  const clean = (h: string) => h.startsWith("0x") ? h.slice(2) : h;
  return (
    <div className={`p-4 rounded-xl border ${teal ? "border-[#00E5C4]/40 bg-[#00E5C4]/5" : "border-white/10 bg-white/5"}`}>
      <div className={`text-xs font-mono uppercase tracking-widest mb-3 ${teal ? "text-[#00E5C4]" : "text-white/40"}`}>
        {label}
      </div>
      <div className="space-y-2">
        <div>
          <span className="text-xs text-white/30 font-mono">COMMITMENT </span>
          <span className="font-mono text-xs text-white/70">
            {clean(note.commitment).slice(0, 8)}…{clean(note.commitment).slice(-8)}
          </span>
        </div>
        <div>
          <span className="text-xs text-white/30 font-mono">AMOUNT </span>
          <span className="font-mono text-xs text-white/70">
            {(Number(note.amount) / 10_000_000).toFixed(7)}
          </span>
        </div>
        {note.memo && (
          <div>
            <span className="text-xs text-white/30 font-mono">MEMO </span>
            <span className="font-mono text-xs text-white/60">{note.memo}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TransferPage() {
  const [step, setStep] = useState<Step>("load_note");
  const [error, setError] = useState<string | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [inputNote, setInputNote] = useState<Note | null>(null);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [newNote, setNewNote] = useState<Note | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const [nullifierSpent, setNullifierSpent] = useState(false);
  const proofEst = estimateProofTime();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Step 1: load note ──
  const handleLoadNote = useCallback(async () => {
    setError(null);
    let note: Note;
    try {
      note = loadFromString(noteInput);
    } catch (e) {
      setError((e as Error).message);
      return;
    }

    if (note.spent) {
      setNullifierSpent(true);
      setError("This note has already been used.");
      return;
    }

    // Check on-chain nullifier
    try {
      const spent = await getNullifierStatus(note.nullifier);
      if (spent) {
        setNullifierSpent(true);
        setError("This note has already been spent on-chain.");
        return;
      }
    } catch {
      // Non-fatal — continue optimistically if RPC check fails
    }

    setInputNote(note);
    setStep("enter_recipient");
  }, [noteInput]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setNoteInput((ev.target?.result as string) ?? "");
    reader.readAsText(file);
  }, []);

  // ── Step 2 → 3 → 4: transfer ──
  const handleTransfer = useCallback(async () => {
    if (!inputNote) return;
    if (!StrKey.isValidEd25519PublicKey(recipientAddress)) {
      setError("Enter a valid Stellar address.");
      return;
    }

    const stellarSK = sessionStorage.getItem("ss_sk");
    if (!stellarSK) {
      setError("Session secret not found. Re-enter your secret key.");
      return;
    }

    setError(null);

    try {
      // Fetch Merkle state
      setStep("generating_proof");
      const [merkleRoot, merklePath] = await Promise.all([
        getCurrentMerkleRoot(),
        getMerklePath(inputNote.leafIndex),
      ]);

      // Build new note for recipient
      const newSecret = generateSecret();
      const recipientField = await stellarPubkeyToField(recipientAddress);
      const recipientPubkeyHex = "0x" + recipientField.toString(16).padStart(64, "0");
      const senderField = await stellarPubkeyToField(Keypair.fromSecret(stellarSK).publicKey());

      const outputNote = await createNote({
        secret: newSecret,
        amount: inputNote.amount,
        assetId: inputNote.assetId,
        recipientPubkey: recipientPubkeyHex,
        leafIndex: 0, // updated after tx confirms
        spent: false,
        memo: `Transfer from ${Keypair.fromSecret(stellarSK).publicKey().slice(0, 8)}…`,
      });

      // Generate proof with progress timer
      const start = Date.now();
      const timer = setInterval(() => setElapsed(Date.now() - start), 200);

      const rawProof = await generateTransferProof({
        nullifier: inputNote.nullifier,
        newCommitment: outputNote.commitment,
        merkleRoot,
        assetId: inputNote.assetId,
        secret: inputNote.secret,
        amount: inputNote.amount.toString(),
        leafIndex: inputNote.leafIndex.toString(),
        merklePath: merklePath.path,
        merklePathIndices: merklePath.indices.map(String),
        recipientPubkeyNew: recipientPubkeyHex,
        newSecret,
        senderPubkey: "0x" + senderField.toString(16).padStart(64, "0"),
      });
      clearInterval(timer);

      const proof = formatProofForSoroban(rawProof);

      // Submit
      setStep("submitting");
      const keypair = Keypair.fromSecret(stellarSK);
      const result = await transferInPool({
        sourceKeypair: keypair,
        nullifier: Buffer.from(inputNote.nullifier.slice(2), "hex"),
        newCommitment: Buffer.from(outputNote.commitment.slice(2), "hex"),
        merkleRoot: Buffer.from(merkleRoot.slice(2), "hex"),
        assetId: Buffer.from(inputNote.assetId.slice(2), "hex"),
        proof,
      });

      if (!result.success) throw new Error(result.error ?? "Transaction failed");

      // Persist: mark old note spent, save new note
      const storageKey = await deriveStorageKey(stellarSK);
      await Promise.all([
        markSpent(inputNote.commitment, storageKey),
        saveNote(outputNote, storageKey),
      ]);

      setNewNote(outputNote);
      setTxHash(result.txHash);
      setStep("complete");
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }, [inputNote, recipientAddress]);

  function copyRecipientNote() {
    if (!newNote) return;
    navigator.clipboard.writeText(noteToString(newNote)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadRecipientNote() {
    if (!newNote) return;
    const blob = new Blob(
      [JSON.stringify(newNote, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shieldsend-note-${newNote.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ──
  return (
    <main className="min-h-screen bg-[#0B0F1A] text-white flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8">
          <a href="/" className="text-white/40 text-sm font-mono hover:text-white/70 transition-colors">
            ← ShieldSend
          </a>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">Private transfer</h1>
          <p className="mt-1 text-white/50 text-sm">
            Spend a note and create a new one for your recipient — no amounts on-chain.
          </p>
        </div>

        <StepDots current={step} />

        {/* Privacy callout */}
        <div className="mb-6 px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-xs text-white/50 leading-relaxed">
          🔒 The transfer amount and your identity are hidden by a zero-knowledge proof.
          Only the proof's validity is recorded on Stellar.
        </div>

        {/* ── Step: load_note ── */}
        {(step === "load_note" || step === "error") && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-white/50 mb-2 font-mono uppercase tracking-widest">
                Paste note string or upload file
              </label>
              <textarea
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                rows={5}
                placeholder={"eyJpZCI6IjEyMzQ...  (base64 note string)\nor paste raw JSON"}
                className="w-full bg-white/5 border border-white/20 rounded-lg px-4 py-3 font-mono text-xs text-white placeholder-white/20 focus:outline-none focus:border-[#00E5C4]/60 transition-colors resize-none"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg border border-white/20 text-white/60 text-sm font-mono hover:bg-white/5 transition-colors"
              >
                Upload JSON
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleFileUpload}
              />
              <button
                onClick={handleLoadNote}
                disabled={!noteInput.trim()}
                className="flex-1 py-2 rounded-lg bg-[#00E5C4] text-[#0B0F1A] font-bold text-sm hover:bg-[#00E5C4]/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Load note
              </button>
            </div>

            {nullifierSpent && (
              <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-mono">
                This note has already been spent — it cannot be used again.
              </div>
            )}

            {error && !nullifierSpent && (
              <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-mono">
                {error}
              </div>
            )}
          </div>
        )}

        {/* ── Step: enter_recipient ── */}
        {step === "enter_recipient" && inputNote && (
          <div className="space-y-4">
            <NoteCard note={inputNote} label="Your note (to be spent)" />

            <div>
              <label className="block text-xs text-white/50 mb-2 font-mono uppercase tracking-widest">
                Recipient Stellar address
              </label>
              <input
                type="text"
                value={recipientAddress}
                onChange={(e) => setRecipientAddress(e.target.value)}
                placeholder="G..."
                className="w-full bg-white/5 border border-white/20 rounded-lg px-4 py-3 font-mono text-xs text-white placeholder-white/20 focus:outline-none focus:border-[#00E5C4]/60 transition-colors"
              />
            </div>

            {error && (
              <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-mono">
                {error}
              </div>
            )}

            <button
              onClick={handleTransfer}
              disabled={!recipientAddress}
              className="w-full py-3 rounded-lg bg-[#00E5C4] text-[#0B0F1A] font-bold text-sm hover:bg-[#00E5C4]/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Generate proof & transfer
            </button>
          </div>
        )}

        {/* ── Step: generating_proof ── */}
        {step === "generating_proof" && (
          <div className="space-y-6">
            <div className="px-4 py-3 rounded-lg bg-white/5 border border-white/10">
              <div className="flex justify-between text-xs font-mono text-white/40 mb-2">
                <span>Generating Groth16 transfer proof…</span>
                <span>{(elapsed / 1000).toFixed(1)}s / ~{(proofEst / 1000).toFixed(1)}s</span>
              </div>
              <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#00E5C4] transition-all duration-200"
                  style={{ width: `${Math.min(98, (elapsed / proofEst) * 100)}%` }}
                />
              </div>
              <p className="mt-3 text-xs text-white/30">
                This takes ~{(proofEst / 1000).toFixed(0)}s. Your secret never leaves this browser.
              </p>
            </div>
          </div>
        )}

        {/* ── Step: submitting ── */}
        {step === "submitting" && (
          <div className="flex items-center gap-3 text-sm text-white/60 font-mono">
            <div className="w-4 h-4 border-2 border-[#00E5C4] border-t-transparent rounded-full animate-spin" />
            Submitting to Stellar testnet…
          </div>
        )}

        {/* ── Step: complete ── */}
        {step === "complete" && inputNote && newNote && (
          <div className="space-y-5">
            <NoteCard note={{ ...inputNote, spent: true }} label="Your note — SPENT" />

            <div className="flex items-center gap-3 text-xs text-white/30 font-mono">
              <div className="flex-1 h-px bg-white/10" />
              transferred to
              <div className="flex-1 h-px bg-white/10" />
            </div>

            <NoteCard note={newNote} label="Recipient's new note" teal />

            {txHash && (
              <div className="px-4 py-2 rounded-lg bg-white/5 border border-white/10">
                <span className="text-xs text-white/30 font-mono">TX </span>
                <span className="font-mono text-xs text-white/60 break-all">{txHash}</span>
              </div>
            )}

            <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              Your note has been spent. The recipient's note is below.{" "}
              <strong>Send it to them through a private channel.</strong>
            </div>

            <div className="flex gap-3">
              <button
                onClick={downloadRecipientNote}
                className="flex-1 py-3 rounded-lg border border-[#00E5C4]/40 text-[#00E5C4] text-sm font-mono hover:bg-[#00E5C4]/10 transition-colors"
              >
                Download note
              </button>
              <button
                onClick={copyRecipientNote}
                className="flex-1 py-3 rounded-lg border border-white/20 text-white/70 text-sm font-mono hover:bg-white/5 transition-colors"
              >
                {copied ? "Copied!" : "Copy note string"}
              </button>
            </div>

            <a
              href="/"
              className="block text-center text-sm text-white/40 font-mono hover:text-white/70 transition-colors"
            >
              ← Back to dashboard
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
