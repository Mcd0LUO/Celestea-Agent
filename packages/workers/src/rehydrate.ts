/**
 * W1470 — rebuild ADDRESSABLE worker state from the PERSISTED table.
 *
 * The failure this module closes: `SessionRegistry` mints `<prefix>session-<n>`
 * in memory and dies with the process, while the table it wrote survives. After a
 * restart the row still NAMES its conversation (`sess=`) and its dispatcher
 * (`host=`), but nothing resolves it any more — `send_message` answers
 * `not_found` and the worker is simply gone from `worker_status`.
 *
 * The rule is "rebuild from the persisted fact", not "treat everything as new":
 *
 *   - a row belongs to a host conversation when its `sess` was minted with that
 *     conversation's prefix AND its `host=` is either absent (a pre-W787 row) or
 *     that conversation. A row of a SIBLING host is neither adopted nor
 *     re-minted — its ids are only RESERVED, because the host's
 *     `workerSessionPrefix` folds `/` to `_` and two distinct conversations can
 *     therefore share one prefix;
 *   - every persisted id is reserved, so the counter can never hand an id the
 *     table already names to a DIFFERENT worker (the cross-restart collision);
 *   - adoption is READ-ONLY. It creates the addressable session and nothing
 *     else: no row is rewritten, and the P0 judgement (`recovery.ts`) is not
 *     touched. Settling a ghost is P2 and lives in `recover-apply.ts`.
 *
 * The rehydrated session carries the row's OWN meta tokens (title / workspace /
 * model / mode / permission) and a fresh (empty) log — the transcript is not
 * persisted for worker sessions by construction (W831 R3 B4: even the readable
 * brief is memory-only), so nothing here pretends to restore a conversation.
 */

import type { WorkerEntry } from "@celestea/core";
import { getExtra, summarize } from "./registry-tsv.js";
import { entryView } from "./row.js";
import type { SessionRegistry } from "./sessions.js";
import { workerTitle, type WorkerSessionMeta } from "./types.js";

/** Which persisted rows one registry may rebuild state from. */
export interface InheritFilter {
  /** The host conversation of this registry (`null` = an embedded registry). */
  host: string | null;
  /** The registry's session-id prefix (`workerSessionPrefix(host)`). */
  prefix: string;
}

/** The rows of THIS host conversation's workers, in table order (pure). */
export function inheritableRows(rows: readonly WorkerEntry[], filter: InheritFilter): WorkerEntry[] {
  const mine: WorkerEntry[] = [];
  for (const row of rows) {
    const sess = getExtra(row, "sess");
    if (sess === null || !sess.startsWith(filter.prefix)) continue;
    const rowHost = getExtra(row, "host");
    if (filter.host !== null && rowHost !== null && rowHost !== filter.host) continue;
    mine.push(row);
  }
  return mine;
}

/** The addressable session one row names, from the row's own tokens (or null). */
export function sessionMetaOf(entry: WorkerEntry): WorkerSessionMeta | null {
  const id = getExtra(entry, "sess");
  if (id === null || id === "") return null;
  const short = getExtra(entry, "title");
  return {
    id,
    // The row keeps only the folded SHORT title, so the display title is derived
    // through the ONE shared convention (types.workerTitle) — a target that
    // resolved by title before the restart keeps resolving after it.
    title: short === null ? entry.wid : workerTitle(entry.wid, short),
    workspace: getExtra(entry, "workspace"),
    model: getExtra(entry, "model"),
    mode: getExtra(entry, "mode"),
    permission: getExtra(entry, "permission"),
  };
}

/** Every session id the table names (`sess=`), for reservation. */
export function persistedSessionIds(rows: readonly WorkerEntry[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const sess = getExtra(row, "sess");
    if (sess !== null && sess !== "") ids.push(sess);
  }
  return ids;
}

/**
 * W1470: rebuild addressable sessions + reserve every persisted id. Called by the
 * registry's `reload()`, so it runs once per registry construction (and is
 * idempotent: an id that is already registered is never replaced by a
 * placeholder, which is what keeps a live session from being downgraded by a
 * later reload).
 */
export function hydrateSessions(sessions: SessionRegistry, rows: readonly WorkerEntry[], filter: InheritFilter): void {
  const metas = inheritableRows(rows, filter).map(sessionMetaOf).filter((m): m is WorkerSessionMeta => m !== null);
  sessions.adopt(metas);
  sessions.reserve(persistedSessionIds(rows));
}

/** The two row views `worker_status` is built from. */
export interface StatusSource {
  /** Rows THIS process owns (`proc=` + `host=`; W234/W787). */
  ownEntries(): WorkerEntry[];
  /** Rows of a PREVIOUS generation of this host conversation (W1470). */
  inheritedEntries(): WorkerEntry[];
}

/**
 * The `worker_status` payload: the OWN rows are the counting basis (the frozen
 * W787 view rule), and the inherited rows are an ADDITIVE list — a row the table
 * still names must be reportable, but it must not be counted as a live worker of
 * this generation. A wid lookup falls back to the inherited row and marks it
 * (`inherited: true`) so the caller can tell the two apart.
 */
export function statusView(source: StatusSource, wid?: string | null): Record<string, unknown> {
  const own = source.ownEntries();
  const inherited = source.inheritedEntries();
  if (wid !== undefined && wid !== null && wid !== "") {
    const ownHit = own.find((e) => e.wid === wid);
    const row = ownHit ?? inherited.find((e) => e.wid === wid);
    if (row === undefined) return { ok: false, step: "lookup", error: `no worker ${wid} in registry` };
    return { ok: true, wid, worker: { ...entryView(row), inherited: ownHit === undefined } };
  }
  const summary = summarize(own) as unknown as Record<string, unknown>;
  return inherited.length === 0 ? summary : { ...summary, inherited: inherited.map((e) => entryView(e)) };
}
