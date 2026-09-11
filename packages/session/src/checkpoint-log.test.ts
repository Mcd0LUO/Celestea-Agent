/**
 * The checkpoint decorator + the store's write timings (iteration E §1.2.2) and
 * the two properties the host depends on: the wrapper is TRANSPARENT for every
 * other `SessionLog` member, and a sidecar failure can never break a turn.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionLog } from "@celestea/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKPOINT_FILE_NAME,
  CHECKPOINT_VERSION,
  checkpointPathFor,
  CheckpointStore,
  readCheckpointFile,
  type Checkpoint,
} from "./checkpoint.js";
import { checkpointedLog, checkpointStoreOf, markCleanShutdown, writeErrorCountOf } from "./checkpoint-log.js";
import { PersistentSessionLog } from "./log/persistent.js";

const SESSION = "ws/s1";
const IDENTITY = { boot_id: "b-feedface", pid: 777 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckptlog-"));
  roots.push(dir);
  return dir;
}

function sidecar(dir: string): Checkpoint {
  return JSON.parse(readFileSync(checkpointPathFor(dir), "utf8")) as Checkpoint;
}

function storeOn(dir: string, log: SessionLog, warns: string[] = []): CheckpointStore {
  return new CheckpointStore({
    dir,
    session: SESSION,
    identity: IDENTITY,
    now: () => 5_000,
    warn: (message) => warns.push(message),
    logWriteErrors: () => writeErrorCountOf(log),
  });
}

function persistent(dir: string): SessionLog {
  return PersistentSessionLog.open(dir, "cli-main");
}

describe("checkpointed read/write (data-file contract)", () => {
  it("writes version 1, mode 0600, and round-trips read -> write -> re-read", () => {
    const dir = tmpDir();
    const store = new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 5_000 });
    store.turnStarted("turn-7");

    const path = checkpointPathFor(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    const read = readCheckpointFile(path, SESSION);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.value.version).toBe(CHECKPOINT_VERSION);
    expect(read.value.open_turn).toEqual({ id: "turn-7", started_at: 5_000 });
    expect(read.value.clean_shutdown).toBe(false);
    // Rewriting the value that was read reproduces the same bytes (round trip).
    const before = readFileSync(path, "utf8");
    const again = new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 5_000 });
    expect(again.current).toEqual(read.value);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false); // tmp is renamed away
  });

  it("keeps the atomic tmp file out of the way (no leftovers after a write)", () => {
    const dir = tmpDir();
    const store = new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 1 });
    store.turnStarted("turn-1");
    store.turnEnded("completed");
    expect(readCheckpointFile(checkpointPathFor(dir), SESSION).kind).toBe("ok");
    expect(sidecar(dir).last_outcome).toBe("completed");
  });
});

describe("the decorator records the three write timings", () => {
  it("mirrors turn_start and turn_end (and only those rows)", () => {
    const dir = tmpDir();
    const inner = persistent(dir);
    const log = checkpointedLog(inner, storeOn(dir, inner));
    // Non-boundary rows MUST NOT write (three write timings only, §1.2.2).
    log.append({ type: "user_message", text: "不写 checkpoint" });
    expect(existsSync(checkpointPathFor(dir))).toBe(false);

    log.append({ type: "turn_start", id: log.nextTurnId() });
    expect(sidecar(dir).open_turn).toEqual({ id: "turn-0", started_at: 5_000 });
    expect(sidecar(dir).clean_shutdown).toBe(false);

    log.append({ type: "turn_end", id: "turn-0", outcome: "completed" });
    expect(sidecar(dir).open_turn).toBeNull();
    expect(sidecar(dir).last_outcome).toBe("completed");
  });

  it("treats a legacy turn_end without outcome as completed (log codec semantics)", () => {
    const dir = tmpDir();
    const inner = persistent(dir);
    const log = checkpointedLog(inner, storeOn(dir, inner));
    log.append({ type: "turn_start", id: "turn-0" });
    log.append({ type: "turn_end", id: "turn-0" });
    expect(sidecar(dir).last_outcome).toBe("completed");
  });

  it("forgets the open turn when the log is cleared, and marks a clean shutdown", () => {
    const dir = tmpDir();
    const inner = persistent(dir);
    const log = checkpointedLog(inner, storeOn(dir, inner));
    log.append({ type: "turn_start", id: "turn-0" });
    log.clear();
    expect(sidecar(dir).open_turn).toBeNull();
    expect(log.events()).toEqual([]);

    log.append({ type: "turn_start", id: "turn-1" });
    expect(markCleanShutdown(log)).toBe(true);
    const cp = sidecar(dir);
    expect(cp.clean_shutdown).toBe(true);
    expect(cp.open_turn).toBeNull();
  });

  it("is transparent: path / writeErrorCount / events / peek all reach the inner log", () => {
    const dir = tmpDir();
    const inner = PersistentSessionLog.open(dir, "cli-main");
    const log = checkpointedLog(inner, storeOn(dir, inner));
    expect((log as { path?: string }).path).toBe(inner.path);
    expect(writeErrorCountOf(log)).toBe(0);
    expect((log as { peekTurnNumber?: () => number }).peekTurnNumber?.()).toBe(0);
    expect(checkpointStoreOf(log)?.session).toBe(SESSION);
    expect(checkpointStoreOf(inner)).toBeNull();
    log.append({ type: "turn_start", id: log.nextTurnId() });
    expect(log.events()).toHaveLength(1);
    (log as { close?: () => void }).close?.();
  });

  it("A7 (sidecar half): samples the log's write-error counter into degraded", () => {
    const dir = tmpDir();
    const failing: SessionLog = {
      append: () => undefined,
      events: (): SessionEvent[] => [],
      deriveMessages: () => [],
      clear: () => undefined,
      nextTurnId: () => "turn-0",
    };
    const withCounter = Object.assign(failing, { writeErrorCount: (): number => 3 });
    const log = checkpointedLog(withCounter, storeOn(dir, withCounter));
    log.append({ type: "turn_end", id: "turn-0", outcome: "interrupted" });
    expect(sidecar(dir).degraded.log_write_errors).toBe(3);
  });

  it("never fails a turn when the sidecar cannot be written", () => {
    const dir = tmpDir();
    mkdirSync(checkpointPathFor(dir)); // a DIRECTORY where the file must go: rename fails
    const warns: string[] = [];
    const inner = persistent(dir);
    const log = checkpointedLog(inner, storeOn(dir, inner, warns));
    log.append({ type: "turn_start", id: "turn-0" });
    log.append({ type: "turn_end", id: "turn-0", outcome: "interrupted" });

    expect(log.events()).toHaveLength(2);
    expect(warns.join("\n")).toContain("checkpoint write failed");
    expect(readFileSync(join(dir, "cli-main.jsonl"), "utf8").split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(CHECKPOINT_FILE_NAME).toBe("checkpoint.json");
  });
});

describe("CheckpointStore state machine", () => {
  it("starts from the file on disk and preserves repaired[] across instances", () => {
    const dir = tmpDir();
    const first = new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 1 });
    first.recordSynthesizedTurnEnd("turn-4");
    const second = new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 2 });
    expect(second.current.repaired).toHaveLength(1);
    second.turnStarted("turn-5");
    expect(sidecar(dir).repaired).toHaveLength(1);
    expect(sidecar(dir).open_turn).toEqual({ id: "turn-5", started_at: 2 });
    expect(sidecar(dir).boot_id).toBe(IDENTITY.boot_id);
  });

  it("ignores a corrupt file but reports it, then writes a fresh one on the next boundary", () => {
    const dir = tmpDir();
    writeFileSync(checkpointPathFor(dir), "{ broken");
    const warns: string[] = [];
    const store = new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 3, warn: (m) => warns.push(m) });
    expect(store.load().kind).toBe("invalid");
    expect(store.current.open_turn).toBeNull();
    store.turnStarted("turn-2");
    expect(warns.join("\n")).toContain("checkpoint ignored");
    expect(sidecar(dir).open_turn).toEqual({ id: "turn-2", started_at: 3 });
  });
});
