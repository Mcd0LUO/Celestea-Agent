/**
 * PersistentSessionLog — port of `crates/session/src/persistent.rs:86-280`.
 *
 * A drop-in [SessionLog] whose every appended event is mirrored to disk as one
 * JSON line in a per-session append-only file, while the in-memory semantics of
 * [InMemorySessionLog] (insertion order + the shared `derive_messages`
 * projection) are preserved. `open` replays the file, so a restart reconstructs
 * the same model-visible history and the same turn counter.
 *
 * Failure model: the log stays usable if a disk write fails — the event remains
 * in the in-memory mirror, which IS what `events()` / `deriveMessages()` serve
 * (see [events]), so the model-visible history keeps the row even though the
 * file does not; the failure is counted ([writeErrorCount]) and warned on
 * stderr. Only open/replay/sync surface errors to the caller.
 *
 * Deviation from the legacy implementation (documented, safe direction): it buffers
 * through a `BufWriter`, so `flushEachAppend=false` batches records and a crash can lose
 * them. `fs.writeSync` is unbuffered, so every append already reaches the OS;
 * `flush()` is therefore a no-op and `flushEachAppend=false` cannot lose data.
 * `sync()` is the real durability point (fsync), matching `sync_each_append`.
 *
 * Rotation (P0-2, W1503): the file is bounded by rolling it to a fresh segment
 * (`<path>.1`, `.2`, …) once it reaches [SESSION_LOG_MAX_BYTES] (see
 * `log/file.ts` for the threshold and the segment contract). The roll happens
 * BEFORE the write — the semantics of the usage-ledger precedent,
 * `UsageLedgerFile.rotateIfLarge` — and the descriptor is reopened on the
 * fresh current file immediately, so every rolled segment stays a complete
 * prefix and `open()` replays exactly the stream a never-rotated log would
 * hold. A roll never touches the in-memory mirror, so the live `events()` /
 * `deriveMessages()` views keep projecting that same history (see [events]).
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { deriveMessagesFrom, formatTurnId, nextTurnNumber, serializeSessionEvent } from "@celestea/core";
import type { Message, SessionEvent, SessionLog } from "@celestea/core";
import {
  SESSION_LOG_MAX_BYTES,
  fileLacksFinalNewline,
  filePathFor,
  nextRolledPathFor,
  replaySegments,
  rolledPathsFor,
  segmentPathsFor,
  type TornRecord,
} from "./file.js";

export interface PersistentOptions {
  /** Accepted for parity; writes are unbuffered so no record can be lost. */
  flushEachAppend: boolean;
  /** fsync after every appended record (survives power loss too). */
  syncEachAppend: boolean;
  /**
   * Rotation threshold in bytes (default [SESSION_LOG_MAX_BYTES], 16 MiB).
   * `Infinity` — or any non-positive value — disables rotation; tests inject a
   * small value to exercise a real roll without writing 16 MiB.
   */
  maxBytes?: number;
}

export function defaultPersistentOptions(): PersistentOptions {
  return { flushEachAppend: true, syncEachAppend: false };
}

/** The configured threshold, normalised: non-positive / non-finite = never. */
function maxBytesOf(opts: PersistentOptions): number {
  const max = opts.maxBytes ?? SESSION_LOG_MAX_BYTES;
  return Number.isFinite(max) && max > 0 ? max : Number.POSITIVE_INFINITY;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function warn(message: string): void {
  process.stderr.write(`[celestea-session] ${message}\n`);
}

export class PersistentSessionLog implements SessionLog {
  readonly path: string;
  /** The torn tail found on open (null when the file replayed clean). */
  readonly tornTail: TornRecord | null;

  /**
   * The recorded events, in stream order — the in-memory MIRROR of the logical
   * log, and the source of truth [events] / [deriveMessages] serve. Seeded by
   * the replay in [open] and appended to by every [append] (including one whose
   * disk write failed), so a read never touches the filesystem.
   */
  private recorded: SessionEvent[] = [];
  private turnCounter = 0;
  private fd: number | null = null;
  /** Threshold the OPEN descriptor was acquired under (see [rotateIfLarge]). */
  private fdMaxBytes: number;
  private writeErrors = 0;
  private readonly opts: PersistentOptions;

  private constructor(path: string, opts: PersistentOptions, tornTail: TornRecord | null) {
    this.path = path;
    this.opts = opts;
    this.tornTail = tornTail;
    this.fdMaxBytes = maxBytesOf(opts);
  }

  /** Open (and replay) the append-only log for `sessionId` under `dir`. */
  static open(dir: string, sessionId: string, opts: PersistentOptions = defaultPersistentOptions()): PersistentSessionLog {
    mkdirSync(dir, { recursive: true });
    const path = filePathFor(dir, sessionId);

    // The longest valid prefix wins; a torn tail is truncated away — in the
    // segment that holds it (the rolled `.1` when the process died between the
    // roll and the next record, the current file otherwise). Repairing the
    // segment itself is what keeps a tear from discarding a whole later file.
    const paths = segmentPathsFor(path);
    const replay = replaySegments(paths);
    const tornPath = replay.tornSegment === null ? undefined : paths[replay.tornSegment];
    if (tornPath !== undefined) truncateSync(tornPath, replay.validBytes);
    if (fileLacksFinalNewline(path)) appendFileSync(path, "\n");

    const log = new PersistentSessionLog(path, opts, replay.torn);
    log.recorded = replay.events;
    // P0-A: restore the counter from the replayed file (max id on disk + 1).
    log.turnCounter = nextTurnNumber(replay.events);
    log.reopenFd();
    return log;
  }

  append(event: SessionEvent): void {
    const line = serializeSessionEvent(event);
    try {
      if (this.fd === null) throw new Error("session log is closed");
      this.rotateIfLarge();
      writeSync(this.fd, Buffer.from(`${line}\n`, "utf8"));
      if (this.opts.syncEachAppend) fsyncSync(this.fd);
    } catch (e) {
      this.writeErrors += 1;
      process.stderr.write(
        `[celestea-session] append not persisted to ${this.path} (writeErrorCount=${this.writeErrors}); kept in memory only: ${String(e)}\n`,
      );
    }
    // The in-memory mirror is the source of truth for events()/deriveMessages()
    // (see [events]): keep the event even when the disk path failed, otherwise a
    // failed write would silently drop the row from the model history.
    this.recorded.push(event);
  }

  /**
   * Every recorded event, in stream order — served from the in-memory mirror
   * ([recorded]), never by re-reading the segments.
   *
   * WHY memory and not disk (W9207): this accessor sits on the per-model-step
   * path (`AgentLoop.buildRequest` -> `deriveMessages`, and the usage ledger's
   * `beginStep`), so an O(file) replay here made EVERY step pay a full
   * read + JSON.parse of the whole conversation plus every rolled segment —
   * measured 45 ms at 6.77 MB (~664 ms extrapolated at 100 MB), i.e. ~0.9 s of
   * synchronous main-thread work per 20-step turn. The mirror is seeded by the
   * replay in [open] and kept current by [append], so it is exactly the stream
   * a fresh replay would produce, at O(1) per read.
   *
   * A COPY is returned (the seam contract: "a copy of the recorded events"), so
   * a caller can never mutate the log by mutating the result.
   */
  events(): SessionEvent[] {
    return [...this.recorded];
  }

  deriveMessages(): Message[] {
    return deriveMessagesFrom(this.events());
  }

  nextTurnId(): string {
    return formatTurnId(this.turnCounter++);
  }

  /** The next number the counter would hand out. */
  peekTurnNumber(): number {
    return this.turnCounter;
  }

  /**
   * Empty the LOGICAL log: the current file is truncated and EVERY rolled
   * segment is dropped, so a cleared session cannot resurrect history from a
   * segment file.
   */
  clear(): void {
    this.closeFd();
    this.fd = openSync(this.path, "w"); // truncates
    for (const segment of rolledPathsFor(this.path)) rmSync(segment, { force: true });
    this.fdMaxBytes = maxBytesOf(this.opts);
    this.recorded = [];
    // The emptied file replays to counter 0; keep the live counter in sync.
    this.turnCounter = 0;
  }

  /** No-op: `writeSync` is unbuffered, so records already reached the OS. */
  flush(): void {
    // Intentionally empty — see the module header.
  }

  /** fsync the file so buffered records survive power loss. */
  sync(): void {
    if (this.fd !== null) fsyncSync(this.fd);
  }

  /** How many append-path write failures were recorded (degraded mode). */
  writeErrorCount(): number {
    return this.writeErrors;
  }

  /** Flush + release the descriptor (`Drop`). Idempotent. */
  close(): void {
    this.closeFd();
  }

  private closeFd(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Roll the file to its next segment once it reaches [fdMaxBytes] — BEFORE the
   * record is written (the ledger's `rotateIfLarge` semantics), so every rolled
   * segment is a complete prefix and a torn segment is never rolled.
   *
   * The descriptor is closed first and reopened on the fresh current file
   * HERE, not by the caller: a rotation that left the old descriptor in place
   * would point every later append at the unlinked inode — the exact failure
   * W825 documented for compaction. A failed rename is warned and swallowed
   * (observation discipline): the descriptor is reopened on the SAME path, so
   * the log stays usable and the only consequence is a file that keeps growing.
   */
  private rotateIfLarge(): void {
    if (this.fd === null) return;
    if (statSync(this.path).size < this.fdMaxBytes) return;
    closeSync(this.fd);
    this.fd = null;
    try {
      renameSync(this.path, nextRolledPathFor(this.path));
    } catch (e) {
      warn(`rotation failed (${errorText(e)}); log keeps growing`);
    }
    this.reopenFd();
  }

  /** Open the append descriptor and re-read the threshold of that generation. */
  private reopenFd(): void {
    this.fd = openSync(this.path, "a");
    this.fdMaxBytes = maxBytesOf(this.opts);
  }
}
