"use client";

import { useWalletConnection } from "@solana/react-hooks";
import { JournalCard } from "./components/journal-card";

export default function Home() {
  const { connectors, connect, disconnect, wallet, status } =
    useWalletConnection();

  const address = wallet?.account.address.toString();

  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg1 text-foreground">
      <main className="relative z-10 mx-auto flex min-h-screen max-w-4xl flex-col gap-10 border-x border-border-low px-6 py-16">

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <header className="space-y-2">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">
            Solana dApp
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            On-Chain Journal
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted">
            A fully decentralised journal backed by a Solana Anchor program.
            Every entry is stored in a Program Derived Address owned exclusively
            by your wallet — create, edit, and delete entries on&nbsp;devnet.
          </p>
        </header>

        {/* ── Wallet connection card ────────────────────────────────────────── */}
        <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-lg font-semibold">Wallet</p>
              <p className="text-sm text-muted">
                Connect a Solana wallet to sign transactions on devnet.
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                status === "connected"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-cream text-foreground/80"
              }`}
            >
              {status === "connected" ? "Connected" : "Not connected"}
            </span>
          </div>

          {/* Connector buttons */}
          <div className="grid gap-3 sm:grid-cols-2">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                onClick={() => connect(connector.id)}
                disabled={status === "connecting"}
                className="group flex items-center justify-between rounded-xl border border-border-low bg-card px-4 py-3 text-left text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex flex-col">
                  <span className="text-base">{connector.name}</span>
                  <span className="text-xs text-muted">
                    {status === "connecting"
                      ? "Connecting…"
                      : status === "connected" &&
                          wallet?.connector.id === connector.id
                        ? "Active"
                        : "Tap to connect"}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={`h-2.5 w-2.5 rounded-full transition ${
                    status === "connected" &&
                    wallet?.connector.id === connector.id
                      ? "bg-emerald-500"
                      : "bg-border-low group-hover:bg-primary/80"
                  }`}
                />
              </button>
            ))}
          </div>

          {/* Address + disconnect */}
          <div className="flex flex-wrap items-center gap-3 border-t border-border-low pt-4 text-sm">
            <span className="rounded-lg border border-border-low bg-cream px-3 py-2 font-mono text-xs">
              {address ?? "No wallet connected"}
            </span>
            <button
              onClick={() => disconnect()}
              disabled={status !== "connected"}
              className="inline-flex items-center gap-2 rounded-lg border border-border-low bg-card px-3 py-2 font-medium transition hover:-translate-y-0.5 hover:shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              Disconnect
            </button>
            {status === "connected" && (
              <a
                href="https://faucet.solana.com/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-low bg-card px-3 py-2 text-xs font-medium text-muted transition hover:-translate-y-0.5 hover:shadow-sm"
              >
                Get devnet SOL ↗
              </a>
            )}
          </div>
        </section>

        {/* ── Journal CRUD card ─────────────────────────────────────────────── */}
        <JournalCard />

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <footer className="flex flex-wrap gap-4 border-t border-border-low pt-6 text-xs text-muted">
          <p>
            Built by <a href="https://projo.dev/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Prajyot Tayde</a>
          </p>
          <a
            href={`https://explorer.solana.com/address/4HRxGm7uKwqbDXz7Ywt8FeGtx7GovKMqUGQpEBtiWapc?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            View program on Explorer ↗
          </a>
        </footer>

      </main>
    </div>
  );
}
