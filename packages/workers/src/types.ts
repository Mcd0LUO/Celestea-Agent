/**
 * Worker-side value types shared by the registry, the mailbox and the tools.
 *
 * These are workers-package types on purpose: `core` freezes the engine seams
 * (SessionLog / Llm / Tool / AgentLoop) and the registry row (`WorkerEntry`),
 * while "a session the worker registry can address" and "a mailbox message" are
 * orchestration concepts that only exist inside this package. Every one of them
 * is expressed in terms of core types, so the package still depends on `core`
 * alone (ARCHITECTURE.md §1.1, L1).
 */

import type { SessionLog } from "@celestea/core";

/** Addressing face of a conversation (id / title / workspace grouping). */
export interface WorkerSessionMeta {
  id: string;
  title: string;
  workspace: string | null;
  model: string | null;
}

/** One addressable conversation: its meta plus the log the driver appends to. */
export interface WorkerSession {
  meta: WorkerSessionMeta;
  log: SessionLog;
}

/** `SessionSpec` of the Rust session registry. */
export interface WorkerSessionSpec {
  title: string;
  workspace?: string | null;
  model?: string | null;
}

/** One queued mailbox message (FIFO per session). */
export interface MailboxMessage {
  id: number;
  to: string;
  content: string;
  from_label: string;
  at: number;
}

/** A waiter parked in `recv`, resolved by the next `send` (or by release). */
export type MailboxWaiter = (message: MailboxMessage | null) => void;

/** `format_utc` — `YYYY-MM-DD_HH:MM:SS` in UTC (no chrono, no locale). */
export function formatUtc(secs: number): string {
  const d = new Date(Math.trunc(secs) * 1_000);
  const p = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return `${date}_${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** `utc_now` — the registry timestamp, UTC-marked with a trailing `Z` (W234). */
export function utcNow(now: number = Date.now()): string {
  return `${formatUtc(Math.floor(now / 1_000))}Z`;
}

/** Collapse tab/newline so a value can live inside one `extra` token. */
export function sanitizeExtra(v: string): string {
  return v.replace(/[\t\n\r]/g, " ");
}

/** Character-wise truncation with an ellipsis (never splits a code point). */
export function truncateChars(v: string, max: number): string {
  const chars = [...v];
  return chars.length <= max ? v : `${chars.slice(0, max).join("")}…`;
}
