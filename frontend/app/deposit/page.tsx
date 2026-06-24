"use client";

import { useState, useCallback } from "react";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  generateSecret,
  stellarPubkeyToField,
  assetToField,
  createNote,
  saveNote,
  deriveStorageKey,
  type Note,
} from "../../lib/note";
import {
  generateDepositProof,
  formatProofForSoroban,
  estimateProofTime,
} from "../../lib/proof";
import { depositToPool } from "../../lib/stellar";

// ─── Freighter ────────────────────────────────────────────────────────────────

async function connectFreighter(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freighter = (window as any).freighter;
  if (!freighter) throw new Error("Freighter extension not found. Install it at freighter.app");
  await freighter.requestAccess();
  const { publicKey } = await freighter.getPublicKey();
  return publicKey as string;
}

// ─── Asset config ─────────────────────────────────────────────────────────────

const ASSET_CONFIG: Record<string, { code: string; issuer: string; contractId: string }> = {
  USDC: {
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    contractId: process.env.NEXT_PUBLIC_USDC_CONTRACT_ID ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
  EURC: {
    code: "EURC",
    issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP",
    contractId: process.env.NEXT_PUBLIC_EURC_CONTRACT_ID ?? "",
  },
  XLM: {
    code: "XLM",
    issuer: "",
    contractId: process.env.NEXT_PUBLIC_XLM_CONTRACT_ID ?? "",
  },
};

type AssetKey = keyof typeof ASSET_CONFIG;
type Step = "input" | "generating_proof" | "submitting" | "complete" | "error";

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepTimeline({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "generating_proof", label: "Generating proof" },
    { key: "submitting", label: "Submitting transaction" },
    { key: "complete", label: "Complete" },
  ];
  const order: Step[] = ["input", "generating_proof", "submitting", "complete"];
  const currentIdx = order.indexOf(current);

  return (
    <div className="flex flex-col gap-3 mt-6">
      {steps.map(({ key, label }, i) => {
        const stepIdx = order.indexOf(key);
        const done = currentIdx > stepIdx;
        const active = currentIdx === stepIdx;
        return (
          <div key={key} className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full flex-shrink-0 transition-colors ${
                done
                  ? "bg-[#00E5C4]"
                  : active
                  ? "bg-[#00E5C4] animate-pulse"
                  : "bg-white/20"
              }`}
            />
            {i < steps.length - 1 && (
              <div className="absolute ml-[5px] mt-3 w-px h-3 bg-white/20" />
            )}
            <span
              className={`text-sm font-mono ${
                active ? "text-[#00E5C4]" : done ? "text-white/80" : "text-white/30"
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TruncatedHash({ value }: { value: string }) {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  return (
    <span className="font-mono text-xs text-[#00E5C4]">
      {clean.slice(0, 8)}…{clean.slice(-8)}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DepositPage() {
  const [connectedKey, setConnectedKey] = useState<string | null>(null);
  const [asset, setAsset] = useState<AssetKey>("USDC");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [error, setError] = useState<string | null>(null);
  const [proofEst] = useState(() => estimateProofTime());
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  // ── Connect wallet ──
  const handleConnect = useCallback(async () => {
    try {
      const pk = await connectFreighter();
      setConnectedKey(pk);
      setRecipient(pk); // default to self
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // ── Validation ──
  function validate(): string | null {
    const n = parseFloat(amount);
    if (!amount || isNaN(n) || n <= 0) return "Enter a valid amount greater than 0.";
    if (!StrKey.isValidEd25519PublicKey(recipient)) return "Enter a valid Stellar address.";
    if (!connectedKey) return "Connect your Freighter wallet first.";
    return null;
  }

  // ── Main flow ──
  const handleDeposit = useCallback(async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setError(null);

    try {
      // 1. Compute field elements
      setStep("generating_proof");
      const cfg = ASSET_CONFIG[asset];
      const [recipientField, assetField] = await Promise.all([
        stellarPubkeyToField(recipient),
        assetToField(cfg.code, cfg.issuer),
      ]);

      // Amount in stroops (1 unit = 10_000_000 stroops for Stellar)
      const amountStroops = BigInt(Math.round(parseFloat(amount) * 10_000_000));
      const secret = generateSecret();

      // Temporary leaf index 0 — real index returned post-deposit;
      // deposit circuit doesn't use leafIndex so this is fine.
      const newNote = await createNote({
        secret,
        amount: amountStroops,
        assetId: "0x" + assetField.toString(16).padStart(64, "0"),
        recipientPubkey: "0x" + recipientField.toString(16).padStart(64, "0"),
        leafIndex: 0,
        spent: false,
        memo: `Deposit ${amount} ${asset}`,
      });

      // 2. Generate proof with elapsed timer
      const start = Date.now();
      const timer = setInterval(() => setElapsed(Date.now() - start), 200);

      const rawProof = await generateDepositProof({
        commitment: newNote.commitment,
        amount: amountStroops.toString(),
        assetId: "0x" + assetField.toString(16).padStart(64, "0"),
        secret,
        recipientPubkey: "0x" + recipientField.toString(16).padStart(64, "0"),
      });
      clearInterval(timer);

      const proof = formatProofForSoroban(rawProof);

      // 3. Submit transaction
      setStep("submitting");

      // We need a keypair to sign — derive from Freighter via personal sign hack
      // For hackathon: prompt user for secret key. Production: use Freighter signTransaction.
      const stellarSecretRaw = sessionStorage.getItem("ss_sk");
      if (!stellarSecretRaw) {
        throw new Error(
          "Session secret not found. Please re-enter your secret key (stored in sessionStorage only)."
        );
      }
      const keypair = Keypair.fromSecret(stellarSecretRaw);

      const result = await depositToPool({
        sourceKeypair: keypair,
        assetContractId: cfg.contractId,
        amount: amountStroops,
        commitment: Buffer.from(newNote.commitment.slice(2), "hex"),
        proof,
      });

      if (!result.success) throw new Error(result.error ?? "Transaction failed");

      // 4. Persist note
      const storageKey = await deriveStorageKey(stellarSecretRaw);
      await saveNote(newNote, storageKey);

      setNote(newNote);
      setTxHash(result.txHash);
      setStep("complete");
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }, [asset, amount, recipient, connectedKey]);

  // ── Note download ──
  function downloadNote() {
    if (!note) return;
    const blob = new Blob([JSON.stringify(note, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shieldsend-note-${note.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyNoteString() {
    if (!note) return;
    const str = btoa(JSON.stringify(note, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    navigator.clipboard.writeText(str).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
          <h1 className="mt-4 text-2xl font-bold tracking-tight">Deposit to pool</h1>
          <p className="mt-1 text-white/50 text-sm">
            Your deposit is public. The link to future withdrawals is not.
          </p>
        </div>

        {/* Connect wallet */}
        {!connectedKey ? (
          <button
            onClick={handleConnect}
            className="w-full py-3 rounded-lg border border-[#00E5C4]/40 text-[#00E5C4] font-mono text-sm hover:bg-[#00E5C4]/10 transition-colors"
          >
            Connect Freighter wallet
          </button>
        ) : (
          <div className="mb-6 px-4 py-2 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#00E5C4]" />
            <span className="font-mono text-xs text-white/60 truncate">{connectedKey}</span>
          </div>
        )}

        {/* Input form */}
        {(step === "input" || step === "error") && connectedKey && (
          <div className="space-y-4 mt-6">
            {/* Asset selector */}
            <div>
              <label className="block text-xs text-white/50 mb-2 font-mono uppercase tracking-widest">
                Asset
              </label>
              <div className="flex gap-2">
                {(Object.keys(ASSET_CONFIG) as AssetKey[]).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAsset(a)}
                    className={`px-4 py-2 rounded-lg text-sm font-mono border transition-colors ${
                      asset === a
                        ? "border-[#00E5C4] text-[#00E5C4] bg-[#00E5C4]/10"
                        : "border-white/20 text-white/50 hover:border-white/40"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount */}
            <div>
              <label className="block text-xs text-white/50 mb-2 font-mono uppercase tracking-widest">
                Amount
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  className="w-full bg-white/5 border border-white/20 rounded-lg px-4 py-3 font-mono text-lg text-white placeholder-white/20 focus:outline-none focus:border-[#00E5C4]/60 transition-colors"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-white/40 font-mono text-sm">
                  {asset}
                </span>
              </div>
            </div>

            {/* Recipient */}
            <div>
              <label className="block text-xs text-white/50 mb-2 font-mono uppercase tracking-widest">
                Recipient Stellar address
              </label>
              <input
                type="text"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="G..."
                className="w-full bg-white/5 border border-white/20 rounded-lg px-4 py-3 font-mono text-xs text-white placeholder-white/20 focus:outline-none focus:border-[#00E5C4]/60 transition-colors"
              />
              <p className="mt-1 text-xs text-white/30">Can be your own address — the note is what links you to a future withdrawal.</p>
            </div>

            {error && (
              <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-mono">
                {error}
              </div>
            )}

            <button
              onClick={handleDeposit}
              disabled={!amount || !recipient}
              className="w-full py-3 rounded-lg bg-[#00E5C4] text-[#0B0F1A] font-bold text-sm hover:bg-[#00E5C4]/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Generate proof & deposit
            </button>
          </div>
        )}

        {/* Proof generation / submitting */}
        {(step === "generating_proof" || step === "submitting") && (
          <div className="mt-6">
            <StepTimeline current={step} />

            {step === "generating_proof" && (
              <div className="mt-6">
                <div className="flex justify-between text-xs font-mono text-white/40 mb-2">
                  <span>Generating Groth16 proof…</span>
                  <span>{(elapsed / 1000).toFixed(1)}s / ~{(proofEst / 1000).toFixed(1)}s</span>
                </div>
                <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#00E5C4] transition-all duration-200"
                    style={{ width: `${Math.min(100, (elapsed / proofEst) * 100)}%` }}
                  />
                </div>
                <p className="mt-3 text-xs text-white/30">
                  Proof generated client-side — your secret never leaves this browser.
                </p>
              </div>
            )}

            {step === "submitting" && (
              <div className="mt-6 flex items-center gap-3 text-sm text-white/60 font-mono">
                <div className="w-4 h-4 border-2 border-[#00E5C4] border-t-transparent rounded-full animate-spin" />
                Submitting to Stellar testnet…
              </div>
            )}
          </div>
        )}

        {/* Complete */}
        {step === "complete" && note && (
          <div className="mt-6 space-y-6">
            <StepTimeline current="complete" />

            <div className="p-4 rounded-xl bg-[#00E5C4]/5 border border-[#00E5C4]/30">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-[#00E5C4]" />
                <span className="text-[#00E5C4] text-sm font-semibold">Deposit confirmed</span>
              </div>

              {txHash && (
                <div className="mb-4">
                  <span className="text-xs text-white/40 font-mono">TX HASH</span>
                  <div className="mt-1 font-mono text-xs text-white/70 break-all">{txHash}</div>
                </div>
              )}

              <div className="mb-4">
                <span className="text-xs text-white/40 font-mono">COMMITMENT</span>
                <div className="mt-1">
                  <TruncatedHash value={note.commitment} />
                </div>
              </div>

              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-white/40 font-mono">SECRET</span>
                  <button
                    onClick={() => setSecretRevealed((r) => !r)}
                    className="text-xs text-[#00E5C4] font-mono hover:underline"
                  >
                    {secretRevealed ? "hide" : "reveal"}
                  </button>
                </div>
                <div className="font-mono text-xs text-white/70 break-all">
                  {secretRevealed ? note.secret : "•".repeat(32)}
                </div>
              </div>
            </div>

            {/* Warning */}
            <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              ⚠️ Save this note — it is the <strong>only</strong> way to access your funds.
              It is not stored on-chain or on our servers.
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={downloadNote}
                className="flex-1 py-3 rounded-lg border border-[#00E5C4]/40 text-[#00E5C4] text-sm font-mono hover:bg-[#00E5C4]/10 transition-colors"
              >
                Download backup
              </button>
              <button
                onClick={copyNoteString}
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
