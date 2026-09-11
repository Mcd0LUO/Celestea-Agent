/**
 * Checkpoint sidecar + boot recovery (iteration E §1.2–§1.4, assertions A1–A3,
 * A6, A9). Every case works on a REAL temporary session directory and a REAL
 * `PersistentSessionLog`, because the properties under test are about bytes on
 * disk: "the repair appends exactly one row", "the second boot changes nothing",
 * "a missing sidecar leaves the history untouched".
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSessionEvent, type SessionEvent } from "@celestea/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKPOINT_VERSION,
  checkpointPathFor,
  CheckpointStore,
  readCheckpointFile,
  type Checkpoint,
} from "./checkpoint.js";
import { recoverOpenTurn } from "./checkpoint-recovery.js";
import { parseSessionJsonl } from "./jsonl.js";
import { filePathFor } from "./log/file.js";
import { PersistentSessionLog } from "./log/persistent.js";
import { analyzeReplay } from "./replay.js";

const SESSION = "ws/s1";
const IDENTITY = { boot_id: "b-deadbeef", pid: 4242 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
  roots.push(dir);
  return dir;
}

function logPath(dir: string): string {
  return filePathFor(dir, "cli-main");
}

/** One complete turn, in the engine's native shape. */
function turn(n: number, outcome: "completed" | "interrupted" = "completed"): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `问 ${n}` },
    { type: "assistant_message", text: `答 ${n}` },
    { type: "turn_end", id: `turn-${n}`, outcome },
  ];
}

/** Plant `cli-main.jsonl` verbatim (no reopening: the bytes are the fixture). */
function plantLog(dir: string, events: readonly SessionEvent[], tail = "\n"): string {
  const text = events.map((ev) => serializeSessionEvent(ev)).join("\n");
  writeFileSync(logPath(dir), `${text}${tail}`);
  return logPath(dir);
}

/** Plant a valid sidecar with `patch` applied over a sane default. */
function plantCheckpoint(dir: string, patch: Partial<Checkpoint> = {}, session = SESSION): Checkpoint {
  const value: Checkpoint = {
    version: CHECKPOINT_VERSION,
    session,
    pid: IDENTITY.pid,
    boot_id: IDENTITY.boot_id,
    updated_at: 1_000,
    clean_shutdown: false,
    open_turn: null,
    last_outcome: null,
    degraded: { log_write_errors: 0 },
    lanes: { next_turn: [], next_step: [] },
    repaired: [],
    ...patch,
  };
  writeFileSync(checkpointPathFor(dir), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sidecar(dir: string): Checkpoint {
  return JSON.parse(readFileSync(checkpointPathFor(dir), "utf8")) as Checkpoint;
}

function storeFor(dir: string, warns: string[] = []): CheckpointStore {
  return new CheckpointStore({
    dir,
    session: SESSION,
    identity: IDENTITY,
    now: () => 2_000,
    warn: (message) => warns.push(message),
  });
}

function open(dir: string): PersistentSessionLog {
  return PersistentSessionLog.open(dir, "cli-main");
}

describe("boot recovery: the §1.2.3 decision table", () => {
  it("A1: a crashed open turn is closed with turn_end: interrupted", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(3), { type: "turn_start", id: "turn-4" }, { type: "user_message", text: "崩在这里" }]);
    plantCheckpoint(dir, { open_turn: { id: "turn-4", started_at: 999 } });

    const log = open(dir);
    const outcome = recoverOpenTurn(log, storeFor(dir));

    expect(outcome.action).toBe("closed_turn");
    expect(outcome.appended).toBe(true);
    expect(outcome.turn_id).toBe("turn-4");
    expect(outcome.dangling_before).toEqual(["turn-4"]);
    expect(outcome.dangling_after).toEqual([]);
    const events = log.events();
    expect(events[events.length - 1]).toEqual({ type: "turn_end", id: "turn-4", outcome: "interrupted" });
    const stats = analyzeReplay(parseSessionJsonl(readFileSync(logPath(dir), "utf8")));
    expect(stats.danglingTurns).toBe(0);
    log.close();

    const cp = sidecar(dir);
    expect(cp.open_turn).toBeNull();
    expect(cp.last_outcome).toBe("interrupted");
    expect(cp.repaired).toEqual([{ at: 2_000, action: "synthesize_turn_end", turn_id: "turn-4" }]);
    // The synthesized row is a LEGAL engine row: the log stays protocol-valid.
    expect(analyzeReplay(parseSessionJsonl(readFileSync(logPath(dir), "utf8"))).outcomes).toEqual({
      completed: 1,
      interrupted: 1,
    });
  });

  it("A2: a second boot appends nothing (idempotent) and keeps repaired[] at 1", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(3), { type: "turn_start", id: "turn-4" }]);
    plantCheckpoint(dir, { open_turn: { id: "turn-4", started_at: 999 } });

    const first = open(dir);
    expect(recoverOpenTurn(first, storeFor(dir)).appended).toBe(true);
    first.close();
    const afterFirst = sha256(logPath(dir));

    const second = open(dir);
    const outcome = recoverOpenTurn(second, storeFor(dir));
    expect(outcome.appended).toBe(false);
    expect(outcome.turn_id).toBeNull();
    expect(sha256(logPath(dir))).toBe(afterFirst);
    expect(readFileSync(logPath(dir), "utf8").split("\n").filter((l) => l !== "").length).toBe(6);
    second.close();
    expect(sidecar(dir).repaired).toHaveLength(1);
  });

  it("clears a stale open_turn when the log already holds the turn_end", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(4, "interrupted")]);
    plantCheckpoint(dir, { open_turn: { id: "turn-4", started_at: 999 } });
    const before = sha256(logPath(dir));

    const log = open(dir);
    const outcome = recoverOpenTurn(log, storeFor(dir));
    log.close();

    expect(outcome.action).toBe("cleared_open_turn");
    expect(outcome.appended).toBe(false);
    expect(sha256(logPath(dir))).toBe(before);
    expect(sidecar(dir).open_turn).toBeNull();
    expect(sidecar(dir).repaired).toEqual([]);
  });

  it("A3: a dangling turn WITHOUT a checkpoint is never touched (fail-safe)", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(3), { type: "turn_start", id: "turn-4" }]);
    const before = sha256(logPath(dir));

    const log = open(dir);
    const outcome = recoverOpenTurn(log, storeFor(dir));
    log.close();

    expect(outcome.action).toBe("skipped_no_checkpoint");
    expect(outcome.dangling_after).toEqual(["turn-4"]);
    expect(sha256(logPath(dir))).toBe(before);
    expect(existsSync(checkpointPathFor(dir))).toBe(false);
  });

  it("A9: clean_shutdown: true forbids the repair even with a dangling turn", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(3), { type: "turn_start", id: "turn-4" }]);
    plantCheckpoint(dir, { open_turn: { id: "turn-4", started_at: 999 }, clean_shutdown: true });
    const before = sha256(logPath(dir));

    const log = open(dir);
    const outcome = recoverOpenTurn(log, storeFor(dir));
    log.close();

    expect(outcome.action).toBe("skipped_clean_shutdown");
    expect(outcome.appended).toBe(false);
    expect(sha256(logPath(dir))).toBe(before);
  });

  it("never appends a row for a turn the log does not contain (cleared / rotated log)", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(1)]);
    plantCheckpoint(dir, { open_turn: { id: "turn-9", started_at: 999 } });
    const before = sha256(logPath(dir));

    const log = open(dir);
    const outcome = recoverOpenTurn(log, storeFor(dir));
    log.close();

    expect(outcome.action).toBe("skipped_no_signature");
    expect(outcome.appended).toBe(false);
    expect(sha256(logPath(dir))).toBe(before);
  });

  it("A6: a torn tail is truncated first, then exactly ONE row is appended", () => {
    const dir = tmpDir();
    const prefix: SessionEvent[] = [...turn(3), { type: "turn_start", id: "turn-4" }];
    plantLog(dir, prefix, "\n");
    writeFileSync(logPath(dir), `${readFileSync(logPath(dir), "utf8")}{"type":"turn_st`);
    plantCheckpoint(dir, { open_turn: { id: "turn-4", started_at: 999 } });

    const log = open(dir);
    expect(log.tornTail).not.toBeNull();
    const outcome = recoverOpenTurn(log, storeFor(dir));
    log.close();

    expect(outcome.appended).toBe(true);
    const stats = analyzeReplay(parseSessionJsonl(readFileSync(logPath(dir), "utf8")));
    expect(stats.tornTail).toBeNull();
    expect(stats.parsedEvents).toBe(prefix.length + 1);
    expect(stats.danglingTurns).toBe(0);
  });
});

describe("checkpoint fail-safe (bad / foreign / missing sidecars)", () => {
  const cases: Array<[string, string, string]> = [
    ["corrupt JSON", "{ not json", "checkpoint ignored"],
    ["unknown version", JSON.stringify({ version: 99, session: SESSION, repaired: [] }), "unknown version"],
    ["session mismatch", JSON.stringify({ version: 1, session: "other/ws", repaired: [] }), "session mismatch"],
    ["not an object", "[1,2,3]", "not a JSON object"],
    ["empty file", "  ", "empty file"],
  ];

  for (const [name, body, expected] of cases) {
    it(`${name}: ignored as a whole, observed, and the log is untouched`, () => {
      const dir = tmpDir();
      plantLog(dir, [...turn(3), { type: "turn_start", id: "turn-4" }]);
      writeFileSync(checkpointPathFor(dir), body);
      const before = sha256(logPath(dir));
      const warns: string[] = [];

      const log = open(dir);
      const outcome = recoverOpenTurn(log, storeFor(dir, warns));
      log.close();

      expect(readCheckpointFile(checkpointPathFor(dir), SESSION).kind).toBe("invalid");
      expect(outcome.action).toBe("skipped_invalid_checkpoint");
      expect(outcome.turn_id).toBeNull();
      expect(sha256(logPath(dir))).toBe(before);
      expect(warns.join("\n")).toContain(expected);
    });
  }

  it("treats a foreign file as 'no checkpoint' rather than repairing with it", () => {
    const dir = tmpDir();
    plantLog(dir, [...turn(3), { type: "turn_start", id: "turn-4" }]);
    plantCheckpoint(dir, { open_turn: { id: "turn-4", started_at: 1 } }, "ws/renamed");
    const log = open(dir);
    const outcome = recoverOpenTurn(log, storeFor(dir));
    log.close();
    expect(outcome.action).toBe("skipped_invalid_checkpoint");
    expect(outcome.appended).toBe(false);
  });
});
