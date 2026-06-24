"use client";

import { useState, useEffect } from "react";
import { useWallet } from "../lib/wallet-context";
import { loadNotes, deriveStorageKey, type Note } from "../lib/note";

// ─── Animated headline ────────────────────────────────────────────────────────

const HEADLINE = "Send money. Prove it arrived.\nTell no one how much.";

function AnimatedHeadline() {
  const [displayed, setDisplayed] = useState("");

  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(HEADLINE.slice(0, i));
      if (i >= HEADLINE.length) clearInterval(id);
    }, 40);
    return () => clearInterval(id);
  }, []);

  return (
    <h1 className="text-3xl sm:text-4xl font-bold leading-tight whitespace-pre-line min-h-[6rem]">
      {displayed}
      <span className="animate-pulse text-[#00E5C4]">▊</span>
    </h1>
  );
}

// ─── Note row ─────────────────────────────────────────────────────────────────

function NoteRow({ note }: { note: Note }) {
  const c = note.commitment;
  const short = `${c.slice(2, 10)}…${c.slice(-8)}`;
  const amount = (Number(note.amount) / 10_000_000).toFixed(2);

  return (
    <div className="flex items-center justify-between py-3 border-b border-white/10 last:border-0">
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${note.spent ? "bg-white/20" : "bg-[#00E5C4]"}`} />
        <div>
          <div className="font-mono text-xs text-white/70">{short}</div>
          {note.memo && <div className="text-xs text-white/30 mt-0.5">{note.memo}</div>}
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-sm ${note.spent ? "text-white/30 line-through" : "text-white"}`}>
          {amount}
        </div>
        <div className="text-xs text-white/30">{note.spent ? "spent" : "unspent"}</div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ publicKey }: { publicKey: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [sk] = useState(() => sessionStorage.getItem("ss_sk"));

  useEffect(() => {
    if (!sk) { setNotes([]); return; }
    deriveStorageKey(sk)
      .then((key) => loadNotes(key))
      .then(setNotes)
      .catch(() => setNotes([]));
  }, [sk]);

  const unspent = notes?.filter((n) => !n.spent) ?? [];
  const totalUsdc = unspent.reduce((s, n) => s + Number(n.amount), 0) / 10_000_000;

  return (
    <section className="mt-16 border-t border-white/10 pt-10">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold">Your notes</h2>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#00E5C4]" />
          <span className="font-mono text-xs text-white/50 truncate max-w-[180px]">{publicKey}</span>
        </div>
      </div>

      {notes === null && (
        <div className="text-sm text-white/30 font-mono">Loading notes…</div>
      )}

      {notes !== null && notes.length === 0 && (
        <div className="text-sm text-white/30 font-mono">
          No notes yet. <a href="/deposit" className="text-[#00E5C4] hover:underline">Make a deposit →</a>
        </div>
      )}

      {notes !== null && notes.length > 0 && (
        <>
          <div className="mb-4 px-4 py-3 rounded-lg bg-[#00E5C4]/5 border border-[#00E5C4]/20 flex justify-between items-center">
            <span className="text-xs text-white/40 font-mono uppercase tracking-widest">Total unspent</span>
            <span className="font-mono text-lg text-[#00E5C4]">{totalUsdc.toFixed(2)} USDC</span>
          </div>
          <div>{notes.map((n) => <NoteRow key={n.id} note={n} />)}</div>
        </>
      )}

      {!sk && notes !== null && (
        <p className="mt-3 text-xs text-white/30">
          Enter your secret key in sessionStorage as <code className="text-[#00E5C4]">ss_sk</code> to decrypt notes.
        </p>
      )}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { publicKey, connect } = useWallet();
  const [connectError, setConnectError] = useState<string | null>(null);

  async function handleConnect() {
    try {
      await connect();
    } catch (e) {
      setConnectError((e as Error).message);
    }
  }

  return (
    <main className="min-h-screen bg-[#0B0F1A] text-white">
      <div className="max-w-2xl mx-auto px-6 py-16">

        {/* ── Hero ── */}
        <div className="mb-4">
          <span className="inline-block px-3 py-1 rounded-full border border-[#00E5C4]/30 text-[#00E5C4] text-xs font-mono mb-6">
            Stellar Testnet · Groth16 ZK · Protocol 25
          </span>
          <AnimatedHeadline />
          <p className="mt-4 text-white/50 text-sm leading-relaxed">
            ZK-powered private remittances on Stellar. No amount revealed.
            No counterparty exposed. Just proof.
          </p>
        </div>

        {/* ── CTA buttons ── */}
        <div className="flex flex-wrap gap-3 mt-8">
          <a
            href="/deposit"
            className="px-6 py-3 rounded-lg bg-[#00E5C4] text-[#0B0F1A] font-bold text-sm hover:bg-[#00E5C4]/90 transition-colors"
          >
            Deposit
          </a>
          <a
            href="/transfer"
            className="px-6 py-3 rounded-lg border border-[#00E5C4]/40 text-[#00E5C4] text-sm font-mono hover:bg-[#00E5C4]/10 transition-colors"
          >
            Transfer
          </a>
          <a
            href="/withdraw"
            className="px-6 py-3 rounded-lg border border-white/20 text-white/70 text-sm font-mono hover:bg-white/5 transition-colors"
          >
            Withdraw
          </a>
          {!publicKey && (
            <button
              onClick={handleConnect}
              className="px-6 py-3 rounded-lg border border-white/20 text-white/50 text-sm font-mono hover:bg-white/5 transition-colors"
            >
              Connect Freighter
            </button>
          )}
        </div>
        {connectError && (
          <p className="mt-2 text-xs text-red-400 font-mono">{connectError}</p>
        )}

        {/* ── Feature tiles ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mt-16">
          {[
            { icon: "🔒", title: "Hidden amounts", body: "Transfer amounts never appear on-chain. The pool records only commitment hashes." },
            { icon: "⚡", title: "Stellar speed", body: "Transactions settle in 3–5 seconds. ZK proof generation happens in your browser." },
            { icon: "✅", title: "Compliance-ready", body: "Optional ASP controls let operators enforce allowlists for regulated deployments." },
          ].map(({ icon, title, body }) => (
            <div key={title}>
              <div className="text-2xl mb-3">{icon}</div>
              <div className="font-bold text-sm mb-1">{title}</div>
              <p className="text-xs text-white/40 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>

        {/* ── How it works ── */}
        <section className="mt-16">
          <h2 className="text-lg font-bold mb-8">How it works</h2>
          <div className="relative">
            {/* Vertical connector */}
            <div className="absolute left-[11px] top-4 bottom-4 w-px bg-white/10" />
            <div className="space-y-8">
              {[
                {
                  n: "01",
                  title: "Deposit tokens → receive a private note",
                  body: "Send USDC to the ShieldSend pool. The deposit amount is public, but you receive an encrypted note that no one else can link to a future withdrawal.",
                },
                {
                  n: "02",
                  title: "Transfer the note to anyone",
                  body: "A Groth16 zero-knowledge proof settles on Stellar, spending your note and creating a new one for the recipient. No amount. No link. Just validity.",
                },
                {
                  n: "03",
                  title: "Recipient withdraws to any address",
                  body: "The recipient proves ownership of their note and withdraws. Funds arrive at their Stellar address — unlinked from the original depositor.",
                },
              ].map(({ n, title, body }) => (
                <div key={n} className="flex gap-5">
                  <div className="w-6 h-6 rounded-full border border-white/20 bg-[#0B0F1A] flex items-center justify-center flex-shrink-0 z-10">
                    <span className="text-[10px] font-mono text-white/40">{n}</span>
                  </div>
                  <div>
                    <div className="font-bold text-sm mb-1">{title}</div>
                    <p className="text-xs text-white/40 leading-relaxed">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Dashboard ── */}
        {publicKey && <Dashboard publicKey={publicKey} />}

        {/* ── Footer ── */}
        <footer className="mt-20 pt-8 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-white/20 font-mono">
          <span>ShieldSend · Stellar Hacks ZK 2026</span>
          <div className="flex gap-4">
            <a href="https://github.com/demigodjayydy/shieldsend" className="hover:text-white/50 transition-colors">GitHub</a>
            <a href="https://stellar.expert/explorer/testnet" className="hover:text-white/50 transition-colors">Explorer</a>
          </div>
        </footer>

      </div>
    </main>
  );
}
