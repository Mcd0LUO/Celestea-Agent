/**
 * The SHAPE of one `registry.tsv` row: the token list, the terminal stamp and
 * the AI-facing view (E §2.2.2). Every function here is PURE and total, so the
 * two writers (the registry's state machine and the receipt protocol) produce
 * byte-identical rows by construction.
 *
 * WHY a module of its own: these helpers are the row FORMAT, not the registry's
 * state machine — splitting them keeps `registry.ts` inside the §4.1 budget and
 * makes the token rules testable without an engine.
 *
 * Token rules (`extra` is a space-separated `k=v` list, §2.2.2):
 *   - `proc=<pid>`     row ownership (W234): only our own rows are adjudicated;
 *   - `host=<sid>`     the HOST SESSION that dispatched the worker (G2-6);
 *   - `attempt=<n>`    which try this row is (first = 0, re-dispatch +1, §5.2);
 *   - `lease=<pid>@<unix>` the owning process and when it last touched the row;
 *   - `receipt=<wid>:<attempt>` the idempotency key of the DELIVERED receipt
 *     (`wid:0` for the first try — the same 0-based numbering as the ledger).
 * A value is folded to ONE token (`oneToken`), because the list is whitespace
 * separated.
 */

import type { WorkerEntry, WorkerStatus } from "@celestea/core";
import { getExtra, workerAttempt } from "./registry-tsv.js";
import { sanitizeExtra, truncateChars, utcNow, type WorkerVerdict } from "./types.js";

/** Row ownership: only a matching `proc` token makes a row ours (W234). */
export function isOwn(entry: WorkerEntry, pid: number): boolean {
  return getExtra(entry, "proc") === String(pid);
}

/** Stamp/replace the `proc` token, leaving every other token untouched. */
export function withProc(entry: WorkerEntry, pid: number): WorkerEntry {
  return { ...entry, extra: setToken(entry.extra, "proc", String(pid)) };
}

/** Stamp/replace the `state` token. */
export function withState(entry: WorkerEntry, state: string): WorkerEntry {
  return { ...entry, extra: setToken(entry.extra, "state", sanitizeExtra(state)) };
}

/** Stamp/replace several `k=v` tokens in one pass (every other token kept). */
export function withTokens(entry: WorkerEntry, values: Record<string, string>): WorkerEntry {
  return { ...entry, extra: setTokens(entry.extra, values) };
}

/**
 * W736/W7: the ONE terminal row constructor — status (`verdict.status` or the
 * legacy `ok ? DONE : FAILED`), `ended_at`, the `fail=<reason>`/`stop=<reason>`
 * token and `state=idle` (the driver's mailbox loop is at rest; a stale
 * `in-turn` on a frozen row would read as a turn still running). Pure, so every
 * terminal writer produces byte-identical rows.
 */
export function terminalEntry(entry: WorkerEntry, verdict: WorkerVerdict, nowMs: number): WorkerEntry {
  const status: WorkerStatus = verdict.status ?? (verdict.ok ? "DONE" : "FAILED");
  const tokens: Record<string, string> = { ended_at: utcNow(nowMs), state: "idle" };
  const reason = verdict.reason;
  if (status === "FAILED") tokens["fail"] = oneToken(truncateChars(sanitizeExtra(reason ?? "unspecified failure"), 200));
  if (status === "STOPPED" && reason !== undefined && reason !== null && reason !== "") {
    tokens["stop"] = oneToken(truncateChars(sanitizeExtra(reason), 200));
  }
  return { ...entry, status, extra: setTokens(entry.extra, tokens) };
}

/** Fold whitespace so a value stays ONE `extra` token (the row format needs it). */
export function oneToken(value: string): string {
  return value.replace(/\s+/g, "-");
}

/** Replace/insert several `k=v` tokens in one pass (every other token kept). */
export function setTokens(extra: string, values: Record<string, string>): string {
  const keys = Object.keys(values);
  const tokens = dropTokens(extra, keys).split(/\s+/).filter((tok) => tok !== "");
  for (const key of keys) tokens.push(`${key}=${values[key]}`);
  return tokens.join(" ");
}

/** Remove every `k=v` token of the given keys. */
export function dropTokens(extra: string, keys: readonly string[]): string {
  return extra
    .split(/\s+/)
    .filter((tok) => tok !== "" && !keys.some((k) => tok.startsWith(`${k}=`)))
    .join(" ");
}

export function setToken(extra: string, key: string, value: string): string {
  return setTokens(extra, { [key]: value });
}

/** The AI-facing view of one row (`WorkerEntry::to_json`, + E §2.3 P1). */
export function entryView(entry: WorkerEntry): Record<string, unknown> {
  const proc = getExtra(entry, "proc");
  return {
    wid: entry.wid,
    started_at: entry.started_at,
    status: entry.status,
    sess: getExtra(entry, "sess") ?? "",
    ws: getExtra(entry, "ws") ?? "",
    title: getExtra(entry, "title") ?? "",
    driven: getExtra(entry, "driven") ?? "",
    state: getExtra(entry, "state") ?? "",
    // W736: the terminal stamp of the state machine (null while RUNNING).
    ended_at: getExtra(entry, "ended_at"),
    fail: getExtra(entry, "fail"),
    proc: proc === null ? null : Number.parseInt(proc, 10),
    // E §2.3 P1 ③: the attempt / host / receipt face of the row.
    attempt: workerAttempt(entry),
    host_session: getExtra(entry, "host"),
    last_receipt: getExtra(entry, "receipt"),
    extra: entry.extra,
  };
}
