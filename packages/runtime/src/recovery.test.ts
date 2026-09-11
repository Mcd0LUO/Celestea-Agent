/**
 * Boot recovery over a session DIRECTORY (iteration E §1.3 P0 ③).
 *
 * The session package owns the decision table; this level proves the three
 * things only the orchestrator can get right:
 *   - a session that never ran must not gain an empty log because the host
 *     looked at it (no file creation as a side effect of starting up);
 *   - the log is opened through the PERSISTENT implementation, so a torn tail
 *     left by the crash is truncated exactly as it would be on the next turn;
 *   - the report is the honest observation channel (action + dangling ids).
 */

import { createHash } from "node:crypto";
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSessionEvent, type SessionEvent } from "@celestea/core";
import { afterEach, describe, expect, it } from "vitest";
import { recoverSessionOnBoot, sessionLogPath } from "./recovery.js";

const SESSION = "ws/s1";
const IDENTITY = { boot_id: "b-12345678", pid: 99 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bootrec-"));
  roots.push(dir);
  return dir;
}

function turn(n: number): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `问 ${n}` },
    { type: "turn_end", id: `turn-${n}`, outcome: "completed" },
  ];
}

function plantCrash(dir: string, dangling: SessionEvent[] = [{ type: "turn_start", id: "turn-4" }], tail = "\n"): void {
  const events = [...turn(3), ...dangling];
  writeFileSync(sessionLogPath(dir), `${events.map((ev) => serializeSessionEvent(ev)).join("\n")}${tail}`);
}

function plantCheckpoint(dir: string, patch: Record<string, unknown> = {}): void {
  const value = {
    version: 1,
    session: SESSION,
    pid: 11,
    boot_id: "b-aaaaaaaa",
    updated_at: 5,
    clean_shutdown: false,
    open_turn: { id: "turn-4", started_at: 5 },
    last_outcome: null,
    degraded: { log_write_errors: 0 },
    lanes: { next_turn: [], next_step: [] },
    repaired: [],
    ...patch,
  };
  writeFileSync(join(dir, "checkpoint.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function recover(dir: string, warns: string[] = []): ReturnType<typeof recoverSessionOnBoot> {
  return recoverSessionOnBoot({ dir, session: SESSION, identity: IDENTITY, now: () => 6_000, warn: (m) => warns.push(m) });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lines(dir: string): number {
  return readFileSync(sessionLogPath(dir), "utf8").split("\n").filter((l) => l !== "").length;
}

describe("recoverSessionOnBoot", () => {
  it("does nothing at all — and creates nothing — when the session never ran", () => {
    const dir = tmpDir();
    const report = recover(dir);
    expect(report.action).toBe("skipped_absent_log");
    expect(report.checkpoint).toBe("missing");
    expect(report.appended).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("closes the turn the crash left open and reports what it did", () => {
    const dir = tmpDir();
    plantCrash(dir);
    plantCheckpoint(dir);

    const report = recover(dir);
    expect(report.action).toBe("closed_turn");
    expect(report.turn_id).toBe("turn-4");
    expect(report.appended).toBe(true);
    expect(report.dangling_before).toEqual(["turn-4"]);
    expect(report.dangling_after).toEqual([]);
    expect(report.checkpoint).toBe("ok");
    expect(lines(dir)).toBe(5); // 4 rows of turn-3 + the dangling start + 1 repair

    const sidecar = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8")) as { repaired: unknown[]; open_turn: unknown };
    expect(sidecar.repaired).toHaveLength(1);
    expect(sidecar.open_turn).toBeNull();
  });

  it("is idempotent: the second boot appends nothing to either file", () => {
    const dir = tmpDir();
    plantCrash(dir);
    plantCheckpoint(dir);
    recover(dir);
    const logBytes = sha256(sessionLogPath(dir));
    const cpBytes = sha256(join(dir, "checkpoint.json"));

    const second = recover(dir);
    expect(second.appended).toBe(false);
    expect(second.dangling_after).toEqual([]);
    expect(sha256(sessionLogPath(dir))).toBe(logBytes);
    expect(sha256(join(dir, "checkpoint.json"))).toBe(cpBytes);
  });

  it("A3: a dangling turn without a checkpoint is reported and left alone", () => {
    const dir = tmpDir();
    plantCrash(dir);
    const before = sha256(sessionLogPath(dir));

    const report = recover(dir);
    expect(report.action).toBe("skipped_no_checkpoint");
    expect(report.dangling_after).toEqual(["turn-4"]);
    expect(report.checkpoint).toBe("missing");
    expect(report.warnings).toEqual([]); // nothing was ignored: there was no file
    expect(sha256(sessionLogPath(dir))).toBe(before);
  });

  it("A9: clean_shutdown: true means the shutdown was graceful — no repair", () => {
    const dir = tmpDir();
    plantCrash(dir);
    plantCheckpoint(dir, { clean_shutdown: true, open_turn: null });
    const before = sha256(sessionLogPath(dir));
    const sidecarBefore = sha256(join(dir, "checkpoint.json"));

    const report = recover(dir);
    expect(report.action).toBe("skipped_clean_shutdown");
    expect(report.appended).toBe(false);
    expect(sha256(sessionLogPath(dir))).toBe(before);
    expect(sha256(join(dir, "checkpoint.json"))).toBe(sidecarBefore);
  });

  it("a normal ending leaves nothing dangling (the healthy path stays untouched)", () => {
    const dir = tmpDir();
    writeFileSync(sessionLogPath(dir), `${turn(3).map((ev) => serializeSessionEvent(ev)).join("\n")}\n`);
    plantCheckpoint(dir, { open_turn: null, clean_shutdown: true, last_outcome: "completed" });
    const before = sha256(sessionLogPath(dir));

    const report = recover(dir);
    expect(report.action).toBe("skipped_clean_shutdown");
    expect(report.dangling_before).toEqual([]);
    expect(report.dangling_after).toEqual([]);
    expect(sha256(sessionLogPath(dir))).toBe(before);
  });

  it("reports an unreadable sidecar as invalid and still leaves the log untouched", () => {
    const dir = tmpDir();
    plantCrash(dir);
    writeFileSync(join(dir, "checkpoint.json"), "{ truncated by the crash");
    const before = sha256(sessionLogPath(dir));

    const report = recover(dir);
    expect(report.action).toBe("skipped_invalid_checkpoint");
    expect(report.checkpoint).toBe("invalid");
    expect(report.warnings.join("\n")).toContain("checkpoint invalid");
    expect(sha256(sessionLogPath(dir))).toBe(before);
  });

  it("A6: truncates the torn tail first, then appends exactly one row", () => {
    const dir = tmpDir();
    plantCrash(dir);
    writeFileSync(sessionLogPath(dir), `${readFileSync(sessionLogPath(dir), "utf8")}{"type":"turn_st`);
    plantCheckpoint(dir);

    const report = recover(dir);
    expect(report.appended).toBe(true);
    expect(report.dangling_after).toEqual([]);
    expect(lines(dir)).toBe(5); // 4 rows before the dangling start + the repair
    expect(readFileSync(sessionLogPath(dir), "utf8").trimEnd().endsWith('"outcome":"interrupted"}')).toBe(true);
  });
});
