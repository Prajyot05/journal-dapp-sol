"use client";

import { useState, useEffect, useCallback } from "react";
import {
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import {
  getProgramDerivedAddress,
  getAddressEncoder,
  getUtf8Encoder,
  type Address,
} from "@solana/kit";

// ─── Program constants ─────────────────────────────────────────────────────────

const JOURNAL_PROGRAM_ADDRESS =
  "4HRxGm7uKwqbDXz7Ywt8FeGtx7GovKMqUGQpEBtiWapc" as Address;

const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

// Anchor instruction discriminators (SHA-256("global:<name>")[0..8])
const CREATE_DISCRIMINATOR = new Uint8Array([48, 65, 201, 186, 25, 41, 127, 0]);
const UPDATE_DISCRIMINATOR = new Uint8Array([113, 164, 49, 62, 43, 83, 194, 172]);
const DELETE_DISCRIMINATOR = new Uint8Array([156, 50, 93, 5, 157, 97, 188, 114]);

// ─── Encoding helpers ──────────────────────────────────────────────────────────

/** Borsh-encodes a string: 4-byte LE length prefix + UTF-8 bytes. */
function encodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const buf = new Uint8Array(4 + bytes.length);
  new DataView(buf.buffer).setUint32(0, bytes.length, true /* LE */);
  buf.set(bytes, 4);
  return buf;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function buildCreateData(title: string, content: string): Uint8Array {
  return concat(CREATE_DISCRIMINATOR, encodeString(title), encodeString(content));
}

function buildUpdateData(content: string): Uint8Array {
  return concat(UPDATE_DISCRIMINATOR, encodeString(content));
}

function buildDeleteData(): Uint8Array {
  return new Uint8Array(DELETE_DISCRIMINATOR);
}

// ─── PDA derivation ────────────────────────────────────────────────────────────

async function deriveJournalPda(
  title: string,
  ownerAddress: Address
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: JOURNAL_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode(title),
      getAddressEncoder().encode(ownerAddress),
    ],
  });
  return pda;
}

// ─── Account data parsing ──────────────────────────────────────────────────────

interface JournalEntry {
  pda: Address;
  title: string;
  content: string;
  owner: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

type ViewMode = "list" | "create" | "edit";

interface EditingEntry {
  pda: Address;
  title: string;
  content: string;
}

export function JournalCard() {
  const { wallet, status } = useWalletConnection();
  const { send, isSending } = useSendTransaction();

  // ── Form state ──
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingEntry, setEditingEntry] = useState<EditingEntry | null>(null);

  // ── Entry list (fetched from on-chain via RPC) ──
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isFetching, setIsFetching] = useState(false);

  // ── Transaction feedback ──
  const [txStatus, setTxStatus] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const walletAddress = wallet?.account.address as Address | undefined;

  // ── Fetch journal entries for the connected wallet ──────────────────────────
  const fetchEntries = useCallback(async () => {
    if (!walletAddress) return;
    setIsFetching(true);
    try {
      // Use getProgramAccounts to find all JournalEntryState accounts owned by
      // this wallet.  The account discriminator is the first 8 bytes of the
      // account data (Anchor convention).
      const ACCOUNT_DISCRIMINATOR = new Uint8Array([113, 86, 110, 124, 140, 14, 58, 66]);
      const discriminatorBase64 = btoa(String.fromCharCode(...ACCOUNT_DISCRIMINATOR));

      const rpcUrl = "https://api.devnet.solana.com";
      const ownerBase58 = walletAddress.toString();

      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          JOURNAL_PROGRAM_ADDRESS,
          {
            encoding: "base64",
            // Use "confirmed" so accounts created in the last few seconds are
            // visible immediately.  The default ("finalized") lags ~32 slots
            // (~13 s) behind, which is why newly created entries appear to
            // vanish then suddenly show up on the next refresh.
            commitment: "confirmed",
            filters: [
              // Filter by the 8-byte account discriminator
              {
                memcmp: {
                  offset: 0,
                  bytes: discriminatorBase64,
                  encoding: "base64",
                },
              },
              // Filter by owner pubkey stored at offset 8 (after discriminator)
              {
                memcmp: {
                  offset: 8,
                  bytes: ownerBase58,
                  encoding: "base58",
                },
              },
            ],
          },
        ],
      };

      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      // Surface RPC-level errors instead of silently returning an empty list.
      // This happens when the public endpoint rate-limits the request.
      if (json.error) {
        throw new Error(json.error.message ?? "RPC error");
      }

      const accounts = json.result ?? [];

      const parsed: JournalEntry[] = accounts
        .map(
          (acc: {
            pubkey: string;
            account: { data: [string, string] };
          }) => {
            try {
              const dataB64 = acc.account.data[0];
              const raw = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
              const dv = new DataView(raw.buffer);

              // Skip 8-byte discriminator, read 32-byte owner pubkey
              let offset = 8 + 32;

              // Read title (4-byte LE length + UTF-8)
              const titleLen = dv.getUint32(offset, true);
              offset += 4;
              const titleStr = new TextDecoder().decode(
                raw.slice(offset, offset + titleLen)
              );
              offset += titleLen;

              // Read content
              const contentLen = dv.getUint32(offset, true);
              offset += 4;
              const contentStr = new TextDecoder().decode(
                raw.slice(offset, offset + contentLen)
              );

              return {
                pda: acc.pubkey as Address,
                title: titleStr,
                content: contentStr,
                owner: ownerBase58,
              } satisfies JournalEntry;
            } catch {
              return null;
            }
          }
        )
        .filter(Boolean) as JournalEntry[];

      setEntries(parsed);
    } catch (err) {
      console.error("Failed to fetch journal entries:", err);
      notify(
        "error",
        `Fetch failed: ${
          err instanceof Error ? err.message : "Unknown RPC error"
        }. Try refreshing again.`
      );
    } finally {
      setIsFetching(false);
    }
  }, [walletAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status === "connected") {
      fetchEntries();
    } else {
      setEntries([]);
    }
  }, [status, fetchEntries]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function resetForm() {
    setTitle("");
    setContent("");
    setEditingEntry(null);
    setViewMode("list");
  }

  function notify(type: "success" | "error" | "info", message: string) {
    setTxStatus({ type, message });
    setTimeout(() => setTxStatus(null), 6000);
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (!walletAddress || !title.trim() || !content.trim()) return;
    try {
      notify("info", "Awaiting wallet signature…");
      const pda = await deriveJournalPda(title.trim(), walletAddress);

      const signature = await send({
        instructions: [
          {
            programAddress: JOURNAL_PROGRAM_ADDRESS,
            accounts: [
              { address: pda, role: 1 },              // writable PDA
              { address: walletAddress, role: 3 },    // writable + signer (owner)
              { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
            ],
            data: buildCreateData(title.trim(), content.trim()),
          },
        ],
      });

      notify("success", `Entry created! Tx: ${signature?.slice(0, 20)}…`);
      resetForm();
      // Small pause so the confirmed account is visible at "confirmed" commitment
      // before we re-query — avoids a race where we fetch faster than the RPC
      // has indexed the new account.
      await new Promise((r) => setTimeout(r, 1500));
      await fetchEntries();
    } catch (err) {
      notify(
        "error",
        `Create failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }, [walletAddress, title, content, send, fetchEntries]);

  const handleUpdate = useCallback(async () => {
    if (!walletAddress || !editingEntry || !content.trim()) return;
    try {
      notify("info", "Awaiting wallet signature…");

      const signature = await send({
        instructions: [
          {
            programAddress: JOURNAL_PROGRAM_ADDRESS,
            accounts: [
              { address: editingEntry.pda, role: 1 },
              { address: walletAddress, role: 3 },
              { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
            ],
            data: buildUpdateData(content.trim()),
          },
        ],
      });

      notify("success", `Entry updated! Tx: ${signature?.slice(0, 20)}…`);
      resetForm();
      await new Promise((r) => setTimeout(r, 1500));
      await fetchEntries();
    } catch (err) {
      notify(
        "error",
        `Update failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }, [walletAddress, editingEntry, content, send, fetchEntries]);

  const handleDelete = useCallback(
    async (entry: JournalEntry) => {
      if (!walletAddress) return;
      if (
        !window.confirm(
          `Delete "${entry.title}"? This is permanent and cannot be undone.`
        )
      )
        return;
      try {
        notify("info", "Awaiting wallet signature…");

        const signature = await send({
          instructions: [
            {
              programAddress: JOURNAL_PROGRAM_ADDRESS,
              accounts: [
                { address: entry.pda, role: 1 },
                { address: walletAddress, role: 3 },
                { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
              ],
              data: buildDeleteData(),
            },
          ],
        });

        notify("success", `Entry deleted! Tx: ${signature?.slice(0, 20)}…`);
        await new Promise((r) => setTimeout(r, 1500));
        await fetchEntries();
      } catch (err) {
        notify(
          "error",
          `Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`
        );
      }
    },
    [walletAddress, send, fetchEntries]
  );

  function startEdit(entry: JournalEntry) {
    setEditingEntry({ pda: entry.pda, title: entry.title, content: entry.content });
    setContent(entry.content);
    setTitle(entry.title);
    setViewMode("edit");
  }

  // ── Disconnected state ────────────────────────────────────────────────────────

  if (status !== "connected") {
    return (
      <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
        <div className="space-y-1">
          <p className="text-lg font-semibold">Journal dApp</p>
          <p className="text-sm text-muted">
            Connect your wallet to create, read, update, and delete on-chain journal entries.
          </p>
        </div>
        <div className="rounded-xl border border-border-low bg-cream/40 px-6 py-10 text-center">
          <p className="text-sm text-muted">Wallet not connected</p>
        </div>
      </section>
    );
  }

  // ── Connected ─────────────────────────────────────────────────────────────────

  return (
    <section className="w-full max-w-3xl space-y-6 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-lg font-semibold">Journal dApp</p>
          <p className="text-sm text-muted">
            Your on-chain journal — stored in Solana PDAs, owned only by you.
          </p>
        </div>
        <span className="rounded-full bg-cream px-3 py-1 text-xs font-semibold uppercase tracking-wide text-foreground/80">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* ── Toast notification ────────────────────────────────────────────────── */}
      {txStatus && (
        <div
          className={`rounded-xl px-4 py-3 text-sm font-medium transition-all ${
            txStatus.type === "success"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : txStatus.type === "error"
              ? "bg-red-500/10 text-red-600 dark:text-red-400"
              : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
          }`}
        >
          {txStatus.message}
        </div>
      )}

      {/* ── Create / Edit form ────────────────────────────────────────────────── */}
      {(viewMode === "create" || viewMode === "edit") && (
        <div className="space-y-4 rounded-xl border border-border-low bg-cream/20 p-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">
            {viewMode === "create" ? "New Entry" : `Editing: ${editingEntry?.title}`}
          </p>

          {/* Title (only on create) */}
          {viewMode === "create" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted">
                Title
              </label>
              <input
                type="text"
                maxLength={50}
                placeholder="e.g. Day 1 on Solana"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isSending}
                className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm outline-none transition placeholder:text-muted/60 focus:border-foreground/30 disabled:opacity-60"
              />
              <p className="text-right text-xs text-muted">{title.length}/50</p>
            </div>
          )}

          {/* Content */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-muted">
              Content
            </label>
            <textarea
              rows={5}
              maxLength={1000}
              placeholder="Write your thoughts here…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isSending}
              className="w-full resize-y rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm leading-relaxed outline-none transition placeholder:text-muted/60 focus:border-foreground/30 disabled:opacity-60"
            />
            <p className="text-right text-xs text-muted">{content.length}/1000</p>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={viewMode === "create" ? handleCreate : handleUpdate}
              disabled={
                isSending ||
                !title.trim() ||
                !content.trim()
              }
              className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSending
                ? "Sending…"
                : viewMode === "create"
                ? "Create Entry"
                : "Save Changes"}
            </button>
            <button
              onClick={resetForm}
              disabled={isSending}
              className="rounded-lg border border-border-low bg-card px-5 py-2.5 text-sm font-medium transition hover:bg-cream/40 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Action bar (list view) ────────────────────────────────────────────── */}
      {viewMode === "list" && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode("create")}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
          >
            + New Entry
          </button>
          <button
            onClick={fetchEntries}
            disabled={isFetching}
            className="rounded-lg border border-border-low bg-card px-4 py-2 text-sm font-medium transition hover:bg-cream/40 disabled:opacity-60"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}

      {/* ── Entry list ────────────────────────────────────────────────────────── */}
      {viewMode === "list" && (
        <div className="space-y-3">
          {isFetching && entries.length === 0 ? (
            <div className="rounded-xl border border-border-low bg-cream/30 px-6 py-10 text-center text-sm text-muted">
              Loading entries…
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-low bg-cream/20 px-6 py-10 text-center">
              <p className="text-sm text-muted">No journal entries yet.</p>
              <p className="mt-1 text-xs text-muted/70">
                Click &quot;+ New Entry&quot; to write your first on-chain journal entry.
              </p>
            </div>
          ) : (
            entries.map((entry) => (
              <EntryRow
                key={entry.pda}
                entry={entry}
                isSending={isSending}
                onEdit={() => startEdit(entry)}
                onDelete={() => handleDelete(entry)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

// ─── EntryRow sub-component ───────────────────────────────────────────────────

function EntryRow({
  entry,
  isSending,
  onEdit,
  onDelete,
}: {
  entry: JournalEntry;
  isSending: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="group rounded-xl border border-border-low bg-cream/10 p-4 transition hover:border-border-strong">
      {/* Row header */}
      <div className="flex items-start justify-between gap-3">
        <button
          onClick={() => setExpanded((p) => !p)}
          className="flex-1 text-left"
        >
          <p className="font-semibold text-foreground">{entry.title}</p>
          {!expanded && (
            <p className="mt-0.5 truncate text-sm text-muted">
              {entry.content}
            </p>
          )}
        </button>

        {/* Controls */}
        <div className="flex shrink-0 items-center gap-2 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={onEdit}
            disabled={isSending}
            title="Edit entry"
            className="rounded-lg border border-border-low bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-cream/60 disabled:opacity-50"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={isSending}
            title="Delete entry"
            className="rounded-lg border border-red-400/40 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-500/10 dark:text-red-400 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 border-t border-border-low pt-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {entry.content}
          </p>
          <p className="mt-3 truncate font-mono text-xs text-muted/60">
            PDA: {entry.pda}
          </p>
        </div>
      )}
    </div>
  );
}
