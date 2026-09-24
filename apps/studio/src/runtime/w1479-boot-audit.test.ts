/**
 * W1479 — the boot repair must reach the durable AUDIT channel, and only when
 * it actually repaired something.
 *
 * WHY THIS FILE EXISTS: `auditRepair` short-circuits on `!report.appended`, and
 * nothing exercised that branch. Deleting the guard so it wrote an audit line
 * for every boot left the WHOLE suite green (measured: 330 files / 2645 passed,
 * 0 failed), because the only caller of `recoverActiveSessionOnBoot` passed no
 * `audit` writer at all. Production DOES wire one (`app.ts` builds a
 * RecoveryAuditWriter), so the untested half was exactly the half that runs.
 *
 * The stakes are forensic: `recovery-audit.jsonl` is how a human later tells
 * "a crash was repaired" from "nothing happened". A line written on a clean
 * boot makes that file lie.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { serializeEventLog } from "@celestea/runtime";
import { RecoveryAuditWriter } from "./recovery-audit.js";
import { recoverActiveSessionOnBoot } from "./boot-recovery.js";

const SESSION = "ws/s1";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function turn(n: number): SessionEvent[] {
  return [
    { type: "turn_start", id: "turn-" + n },
    { type: "user_message", text: "问 " + n },
    { type: "assistant_message", text: "答 " + n },
    { type: "turn_end", id: "turn-" + n, outcome: "completed" },
  ];
}

/** A log a `kill -9` left behind: one closed turn plus an OPEN one. */
function crashedEvents(): SessionEvent[] {
  return [...turn(0), { type: "turn_start", id: "turn-1" }, { type: "user_message", text: "崩在这里" }];
}

/** A log that ended cleanly — boot recovery has nothing to repair. */
function cleanEvents(): SessionEvent[] {
  return turn(0);
}

interface Host {
  dataDir: string;
  sessionDir: string;
  auditPath: string;
  audit: RecoveryAuditWriter;
  recover: () => void;
}

/** A data root with ONE session whose log is `events`, plus the audit writer. */
function makeHost(events: readonly SessionEvent[], checkpoint: Record<string, unknown> | null): Host {
  const root = mkdtempSync(join(tmpdir(), "w1479-boot-"));
  roots.push(root);
  const workspace = join(root, "ws");
  const sessionDir = join(workspace, "s1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "cli-main.jsonl"), serializeEventLog(events));
  if (checkpoint !== null) {
    writeFileSync(join(sessionDir, "checkpoint.json"), JSON.stringify(checkpoint));
  }
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const audit = new RecoveryAuditWriter({ dataDir, env: {}, now: () => 1_700_000_000_000 });
  const resolved = { workspace: "ws", session: "s1", id: SESSION, wsPath: workspace, dir: sessionDir };
  const recover = (): void => {
    recoverActiveSessionOnBoot({
      workspaces: { activeSession: () => SESSION },
      sessions: { resolve: () => ({ ok: true as const, value: resolved }) },
      warn: () => {},
      audit,
    });
  };
  return { dataDir, sessionDir, auditPath: audit.filePath, audit, recover };
}

/** The crash sidecar the previous process left (open turn, not cleanly shut). */
function openTurnCheckpoint(): Record<string, unknown> {
  return {
    version: 1,
    session: SESSION,
    pid: 111,
    boot_id: "b-previous",
    updated_at: 100,
    clean_shutdown: false,
    open_turn: { id: "turn-1", started_at: 100 },
    last_outcome: null,
    degraded: { log_write_errors: 0 },
    lanes: { next_turn: [], next_step: [] },
    repaired: [],
  };
}

/** The audit file's parsed lines (empty when it was never created). */
function auditLines(path: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.trim() === "" ? [] : text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("W1479: the boot repair reaches the audit channel", () => {
  it("writes ONE session_repaired line when it closed a crashed turn", () => {
    const h = makeHost(crashedEvents(), openTurnCheckpoint());
    h.recover();
    const lines = auditLines(h.auditPath);
    expect(lines.map((l) => l["event"])).toEqual(["session_repaired"]);
    expect(lines[0]).toMatchObject({ session: SESSION, turn_id: "turn-1" });
  });

  it("writes NOTHING when there was nothing to repair", () => {
    // A clean log with a clean sidecar: boot recovery is a no-op, so an audit
    // line here would claim a repair that never happened.
    const h = makeHost(cleanEvents(), null);
    h.recover();
    expect(auditLines(h.auditPath)).toEqual([]);
  });
});
