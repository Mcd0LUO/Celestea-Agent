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
 * in the in-memory view (derive_messages keeps working), the failure is counted
 * ([writeErrorCount]) and warned on stderr. Only open/replay/sync surface
 * errors to the caller.
 *
 * Deviation from Rust (documented, safe direction): Rust buffers through a
 * `BufWriter`, so `flushEachAppend=false` batches records and a crash can lose
 * them. `fs.writeSync` is unbuffered, so every append already reaches the OS;
 * `flush()` is therefore a no-op and `flushEachAppend=false` cannot lose data.
 * `sync()` is the real durability point (fsync), matching `sync_each_append`.
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, truncateSync, writeSync } from "node:fs";
import { deriveMessagesFrom, formatTurnId, nextTurnNumber, serializeSessionEvent } from "@celestea/core";
import type { Message, SessionEvent, SessionLog } from "@celestea/core";
import { fileLacksFinalNewline, filePathFor, replayFile, type TornRecord } from "./file.js";

export interface PersistentOptions {
  /** Accepted for parity; writes are unbuffered so no record can be lost. */
  flushEachAppend: boolean;
  /** fsync after every appended record (survives power loss too). */
  syncEachAppend: boolean;
}

export function defaultPersistentOptions(): PersistentOptions {
  return { flushEachAppend: true, syncEachAppend: false };
}

export class PersistentSessionLog implements SessionLog {
  readonly path: string;
  /** The torn tail found on open (null when the file replayed clean). */
  readonly tornTail: TornRecord | null;

  private recorded: SessionEvent[] = [];
  private turnCounter = 0;
  private fd: number | null = null;
  private writeErrors = 0;
  private readonly opts: PersistentOptions;

  private constructor(path: string, opts: PersistentOptions, tornTail: TornRecord | null) {
    this.path = path;
    this.opts = opts;
    this.tornTail = tornTail;
  }

  /** Open (and replay) the append-only log for `sessionId` under `dir`. */
  static open(dir: string, sessionId: string, opts: PersistentOptions = defaultPersistentOptions()): PersistentSessionLog {
    mkdirSync(dir, { recursive: true });
    const path = filePathFor(dir, sessionId);

    // The longest valid prefix wins; a torn tail is truncated away.
    const replay = replayFile(path);
    if (replay.truncated) truncateSync(path, replay.validBytes);
    if (fileLacksFinalNewline(path)) appendFileSync(path, "\n");

    const log = new PersistentSessionLog(path, opts, replay.torn);
    log.recorded = replay.events;
    // P0-A: restore the counter from the replayed file (max id on disk + 1).
    log.turnCounter = nextTurnNumber(replay.events);
    log.fd = openSync(path, "a");
    return log;
  }

  append(event: SessionEvent): void {
    const line = serializeSessionEvent(event);
    try {
      if (this.fd === null) throw new Error("session log is closed");
      writeSync(this.fd, Buffer.from(`${line}\n`, "utf8"));
      if (this.opts.syncEachAppend) fsyncSync(this.fd);
    } catch (e) {
      this.writeErrors += 1;
      process.stderr.write(
        `[celestea-session] append not persisted to ${this.path} (writeErrorCount=${this.writeErrors}); kept in memory only: ${String(e)}\n`,
      );
    }
    // The in-memory view is the source of truth for derive_messages: keep the
    // event even when the disk path failed (graceful degradation).
    this.recorded.push(event);
  }

  events(): SessionEvent[] {
    return [...this.recorded];
  }

  deriveMessages(): Message[] {
    return deriveMessagesFrom(this.recorded);
  }

  nextTurnId(): string {
    return formatTurnId(this.turnCounter++);
  }

  /** The next number the counter would hand out. */
  peekTurnNumber(): number {
    return this.turnCounter;
  }

  clear(): void {
    this.closeFd();
    this.fd = openSync(this.path, "w"); // truncates
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

  /** Flush + release the descriptor (Rust `Drop`). Idempotent. */
  close(): void {
    this.closeFd();
  }

  private closeFd(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
