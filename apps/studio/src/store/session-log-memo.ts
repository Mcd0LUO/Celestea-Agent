/**
 * Memoized session-transcript projection — the hot path behind
 * `SessionsStore.messages()` (`GET /api/sessions/{id}/messages`).
 *
 * WHY: every request used to run `readFileSync` + `parseSessionJsonl` +
 * `projectMessages` over the WHOLE log, synchronously. W1502 measured 29.4ms at
 * the real 4MB log and 809ms at a synthetic 100MB one, with the event loop
 * blocked for the entire call — and the log grows for the life of the session.
 * The endpoint is read-mostly: the GUI re-reads a session it has just read when
 * the user switches panes, refreshes or restores, and nothing changed in between.
 *
 * KEY: `(mtimeMs, size)` of the log file, BOTH fields (see `reuse`). A content
 * hash was rejected on purpose: computing it means reading the whole file, which
 * is the cost this memo exists to avoid.
 *
 * The key is only as good as the writer's discipline, so every read is
 * DOUBLE-STATed: read the file, stat it again, and if `(mtimeMs, size)` moved,
 * treat the bytes in hand as a snapshot of a file that was still being written
 * and retry (`TRANSCRIPT_READ_ATTEMPTS`). An append-only log makes such a
 * snapshot a valid PREFIX, never garbage (`parseSessionJsonl` drops the torn
 * tail), so when the retry budget runs out the last read is returned
 * UNMEMOIZED: a slow answer is acceptable, a wrong cached one is not.
 *
 * SEGMENTS (W1503 rotation, closed here): W1503 bounds the session log by
 * rolling it to `<path>.1`, `.2`, … at 16 MiB, so a transcript becomes SEVERAL
 * files. Reading only the current one drops every rolled segment from the
 * response — measured: 3 messages split "2 in `.1` + 1 in the current file"
 * came back as 1 message, i.e. half the transcript vanished. That gap was found
 * by W1504 (as a tripwire) and is closed HERE.
 *
 * Two things therefore key and read on the SEGMENT SET, never on one file:
 *
 *   1. **Read**: `replayFile(path)` replays every rolled segment oldest-first,
 *      then the current file, keeping the longest valid prefix — the
 *      concatenation IS the pre-rotation stream, so the projection is identical
 *      to a never-rotated log (W1503's own equivalence property).
 *
 *   2. **Key**: the revision is `segmentPathsFor(path).map(stat)`, NOT the
 *      current file's `(mtimeMs, size)`. A roll moves bytes from the tail into
 *      `<path>.N` and leaves the fresh current file at **0 bytes** — exactly the
 *      revision an ALREADY EMPTY session had before it was ever written to. A
 *      single-file key would therefore serve a stale, truncated projection for a
 *      session that had just rolled. Keying on the whole set also makes the
 *      ``.1` → `.2` shift (a second roll) invalidate correctly, which no
 *      per-file key can see.
 *
 * The revision is a LIST, so equality is structural: same paths, same order,
 * same `(mtimeMs, size)` each. Order comes from `segmentPathsFor` (oldest
 * generation first, current file last), so the list is comparable directly.
 */

import { readFileSync, statSync } from "node:fs";
import { parseSessionJsonl, projectMessages, segmentPathsFor } from "@celestea/session";
import type { StudioMessage } from "@celestea/core";

/**
 * LRU bound, in entries. DSH's `coldLogMemo` uses 2, but its handoff spans one
 * session (`observe` → `resume`); this memo serves a UI that switches between
 * sessions, so 2 would thrash on every "switch away, switch back". 4 covers the
 * active session plus the last few the user looked at while retaining only a
 * small multiple of ONE projection (the real 4MB log projects to ~7MB of heap),
 * instead of one entry per session ever opened — an unbounded Map here would be
 * the exact 无界累积 class W1502 swept the tree for.
 */
export const TRANSCRIPT_MEMO_MAX = 4;

/**
 * Full reads allowed for ONE `messages()` call: the initial read plus two
 * retries. A writer that outruns three reads is still appending; the caller gets
 * the last read rather than a fourth blocking pass.
 */
export const TRANSCRIPT_READ_ATTEMPTS = 3;

/** One file's revision, as cheaply as the filesystem can hand it over. */
export interface LogRevision {
  mtimeMs: number;
  size: number;
}

/** One segment's path plus its revision — the unit a rotation can move. */
export interface SegmentRevision {
  path: string;
  revision: LogRevision | null;
}

/**
 * The transcript's revision = **every segment's**, in `segmentPathsFor` order
 * (oldest generation first, current file last). See the module header: a
 * single-file revision cannot see a roll (the current file goes to 0 bytes) nor
 * a second roll shifting `.1` → `.2`.
 */
export type TranscriptRevision = readonly SegmentRevision[];

/** Filesystem seam: production uses node:fs, tests drive interleavings. */
export interface TranscriptIo {
  /**
   * The WHOLE transcript's text: every rolled segment (oldest generation first),
   * then the current file. For a never-rotated log this is just the one file, so
   * the seam keeps its old meaning there.
   */
  read(path: string): string;
  /** The ordered segment paths of a log path (`segmentPathsFor`). */
  segments(path: string): string[];
  stat(path: string): LogRevision | null;
}

const nodeIo: TranscriptIo = {
  read: (path) => segmentTextOf(path),
  segments: (path) => segmentPathsFor(path),
  stat: (path) => {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
};

interface MemoEntry {
  revision: TranscriptRevision;
  messages: StudioMessage[];
}

/**
 * Structural equality of two revisions. Both the path list AND each file's
 * `(mtimeMs, size)` must match: `mtime` alone is too coarse (same-ms rewrites),
 * and `size` alone cannot see a same-size rewrite (`POST /api/clear` writing ""
 * over an already-empty log is exactly that shape).
 */
function sameRevision(a: TranscriptRevision | null, b: TranscriptRevision | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path) return false;
    if (x.revision === null || y.revision === null) {
      if (x.revision !== y.revision) return false;
      continue;
    }
    if (x.revision.mtimeMs !== y.revision.mtimeMs || x.revision.size !== y.revision.size) return false;
  }
  return true;
}

/**
 * The whole transcript's text: every rolled segment (oldest first) then the
 * current file, concatenated. A roll is a whole-file rename, so the
 * concatenation IS the pre-rotation byte stream — this is what makes the
 * projection identical to a never-rotated log.
 *
 * A missing segment is skipped (the current file may legitimately not exist yet
 * on a brand-new session; the caller's `stat` then reports `null`).
 */
function segmentTextOf(path: string): string {
  const paths = segmentPathsFor(path);
  let text = "";
  for (let i = 0; i < paths.length; i += 1) {
    const part = paths[i]!;
    const isCurrent = i === paths.length - 1;
    if (isCurrent) {
      // STRICT on the current file: a deleted log must keep throwing ENOENT
      // (the endpoint's contract before this change), not silently project an
      // empty transcript. Rolled segments below are historical, so a missing one
      // contributes nothing rather than failing the request.
      text += readFileSync(part, "utf8");
      continue;
    }
    try {
      text += readFileSync(part, "utf8");
    } catch {
      /* missing rolled segment: nothing to contribute */
    }
  }
  return text;
}

/** One read plus the revision that says whether the transcript moved under it. */
interface ReadAttempt {
  messages: StudioMessage[];
  after: TranscriptRevision;
  settled: boolean;
}

export class TranscriptMemo {
  /** Insertion order IS the LRU order (re-inserted on every hit). */
  private readonly entries = new Map<string, MemoEntry>();

  constructor(private readonly io: TranscriptIo = nodeIo) {}

  /**
   * The projection of [path] — **every segment, oldest first** — reusing the
   * memoized one when no segment moved.
   *
   * The returned array is SHARED with the cache — callers treat it as read-only
   * (the one in-repo caller serializes it into the HTTP response). Copying it
   * per call would spend the allocation this memo exists to save.
   */
  read(path: string): StudioMessage[] {
    const before = this.revisionOf(path);
    const cached = this.reuse(path, before);
    if (cached !== null) return cached;
    let outcome = this.attempt(path, before);
    for (let attempt = 1; !outcome.settled && attempt < TRANSCRIPT_READ_ATTEMPTS; attempt += 1) {
      outcome = this.attempt(path, outcome.after);
    }
    if (outcome.settled) this.remember(path, outcome.after, outcome.messages);
    return outcome.messages;
  }

  /** Drop [path]'s entry (`truncate()`); the revision guard would miss too. */
  forget(path: string): void {
    this.entries.delete(path);
  }

  /** Entries currently held (tests + diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The revision of the WHOLE transcript: one entry per segment, in
   * `segmentPathsFor` order. A single-file revision cannot see a roll — the
   * fresh current file is 0 bytes, which is also what an untouched empty session
   * looks like — so the set is the smallest thing that can tell them apart.
   */
  private revisionOf(path: string): TranscriptRevision {
    return this.io.segments(path).map((segment) => ({ path: segment, revision: this.io.stat(segment) }));
  }

  /**
   * A hit needs the segment list AND every file's revision equal. `size` is not
   * redundant next to `mtimeMs`: `mtimeMs` comes from the filesystem's timestamp
   * clock, so two writes inside one tick (or a timestamp-preserving write) leave
   * it unchanged, and a same-size rewrite — `POST /api/clear` writing "" over a
   * log that was already empty — is exactly that shape.
   */
  private reuse(path: string, before: TranscriptRevision): StudioMessage[] | null {
    const entry = this.entries.get(path);
    if (entry === undefined || !sameRevision(entry.revision, before)) return null;
    this.entries.delete(path);
    this.entries.set(path, entry);
    return entry.messages;
  }

  /**
   * Replay + project + re-stat the segment set: `settled` means no segment moved
   * under us. The re-stat is what makes an append-only log safe to cache — a
   * snapshot of a file still being written is a valid PREFIX, never garbage, but
   * it must not be remembered as if it were the final state.
   */
  private attempt(path: string, before: TranscriptRevision): ReadAttempt {
    const messages = projectMessages(parseSessionJsonl(this.io.read(path)).events);
    const after = this.revisionOf(path);
    return { messages, after, settled: sameRevision(before, after) };
  }

  /** Insert as most-recently-used, then evict the LRU head down to the cap. */
  private remember(path: string, revision: TranscriptRevision, messages: StudioMessage[]): void {
    this.entries.delete(path);
    this.entries.set(path, { revision, messages });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= TRANSCRIPT_MEMO_MAX) break;
      this.entries.delete(oldest);
    }
  }
}
