/**
 * W1470 P2 on the REAL studio boot path: the switch, the actions, and the default.
 *
 * P0 (`observeWorkerTableOnBoot`) is untouched: it still only judges and audits.
 * The ACTIONS live in `recoverWorkerTableOnBoot` and are armed by exactly one
 * value — `CELESTEA_WORKER_RECOVER=1`. These cases pin all three properties that
 * matter: the default writes nothing, the armed path settles the ghost (DONE with
 * a deliverable, FAILED without one), and a row whose owner is ALIVE is never
 * touched even when the switch is on.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type StudioHarness } from "../harness.test-util.js";
import { RecoveryAuditWriter } from "./recovery-audit.js";
import { observeWorkerTableOnBoot, recoverWorkerTableOnBoot } from "./worker-recovery.js";

const harnesses: StudioHarness[] = [];
const temps: string[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/**
 * W701 dead owner + deliverable; W702 dead owner, nothing; W703 owner ALIVE.
 *
 * The live owner is THIS process, not a hardcoded pid: liveness goes through the
 * product's real `pidAliveDefault` (`process.kill(pid, 0)`), and pid 1 is only
 * alive on POSIX — on Windows it is `ESRCH`, so W703 would be judged stale and
 * the "never touch a live row" half of the test would never run.
 */
const LIVE_PID = process.pid;
function ghostTable(): string {
  return [
    "W701\t2026-09-23_11:00:00Z\tRUNNING\tsess=s1 title=ghost host=ws/gone attempt=0 lease=999999@1789000000 proc=999999",
    "W702\t2026-09-23_11:01:00Z\tRUNNING\tsess=s2 title=ghost2 host=ws/gone attempt=0 lease=999998@1789000000 proc=999998",
    `W703\t2026-09-23_11:02:00Z\tRUNNING\tsess=s3 title=live host=ws/live attempt=0 lease=${LIVE_PID}@1789000000 proc=${LIVE_PID}`,
  ].join("\n") + "\n";
}

/** A data dir with the table plus W701's deliverable (the only evidence P2 uses). */
function dataDirWithGhosts(): string {
  const dir = mkdtempSync(join(tmpdir(), "w1470-boot-"));
  temps.push(dir);
  writeFileSync(join(dir, "worker-registry.tsv"), ghostTable(), "utf8");
  mkdirSync(join(dir, "worker-results"), { recursive: true });
  writeFileSync(join(dir, "worker-results", "W701-ghost-a0.md"), "report\n", "utf8");
  return dir;
}

/** One row's status + extra, parsed the way the table's own parser does. */
interface Row {
  status: string;
  extra: string;
}

function rowOf(dir: string, wid: string): Row {
  const line = readFileSync(join(dir, "worker-registry.tsv"), "utf8").split("\n").find((l) => l.startsWith(`${wid}\t`)) ?? "";
  const parts = line.split("\t");
  return { status: parts[2] ?? "", extra: parts[3] ?? "" };
}

function token(extra: string, key: string): string | null {
  for (const tok of extra.split(/\s+/)) {
    const idx = tok.indexOf("=");
    if (idx > 0 && tok.slice(0, idx) === key) return tok.slice(idx + 1);
  }
  return null;
}

describe("W1470 P2: the boot action is OFF unless CELESTEA_WORKER_RECOVER=1", () => {
  it("with the switch absent the ghost row is judged and left byte-identical", () => {
    const dir = dataDirWithGhosts();
    const before = readFileSync(join(dir, "worker-registry.tsv"), "utf8");
    const report = observeWorkerTableOnBoot({ path: join(dir, "worker-registry.tsv"), resultsDir: join(dir, "worker-results"), env: {}, warn: () => undefined });
    expect(recoverWorkerTableOnBoot({ path: join(dir, "worker-registry.tsv"), resultsDir: join(dir, "worker-results"), env: {}, warn: () => undefined }, report)).toBeNull();
    expect(readFileSync(join(dir, "worker-registry.tsv"), "utf8")).toBe(before);
    // The judgement itself is unchanged: both dead owners are STALE, W703 is live.
    expect(report.stale.map((c) => [c.wid, c.action])).toEqual([["W701", "close_done"], ["W702", "respawn"]]);
    expect(report.live).toEqual(["W703"]);
  });

  it("with the switch armed it claims + settles the ghosts and never the live row", () => {
    const dir = dataDirWithGhosts();
    const audit = new RecoveryAuditWriter({ dataDir: dir, now: () => 1, env: {} });
    // A pinned clock: the handover stamp must be the process's own lease, exactly.
    const input = { path: join(dir, "worker-registry.tsv"), resultsDir: join(dir, "worker-results"), env: { CELESTEA_WORKER_RECOVER: "1" }, audit, now: () => 1, warn: () => undefined };
    const applied = recoverWorkerTableOnBoot(input, observeWorkerTableOnBoot(input));
    expect(applied?.map((a) => [a.wid, a.action, a.outcome])).toEqual([["W701", "close_done", "closed_done"], ["W702", "respawn", "failed"]]);

    expect(rowOf(dir, "W701").status).toBe("DONE");
    expect(token(rowOf(dir, "W701").extra, "ended_at")).not.toBeNull();
    expect(token(rowOf(dir, "W701").extra, "claimed")).toBe(`${process.pid}@0`);
    expect(rowOf(dir, "W702").status).toBe("FAILED");
    expect(token(rowOf(dir, "W702").extra, "fail")).toBe("recovered:-no-recoverable-brief");
    // W703's owner is alive: no claim, no terminal, no token.
    expect(rowOf(dir, "W703").status).toBe("RUNNING");
    expect(token(rowOf(dir, "W703").extra, "claimed")).toBeNull();
    expect(token(rowOf(dir, "W703").extra, "proc")).toBe(String(LIVE_PID));

    const events = readFileSync(join(dir, "recovery-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    // No `knownHost` hook here, so nothing is judged an orphan ("cannot tell" is
    // never a reason to act): two stale lines, the sweep summary, two actions.
    expect(events.map((e) => e["event"])).toEqual(["worker_stale", "worker_stale", "worker_observed", "worker_recovered", "worker_recovered"]);
    expect(events[3]).toMatchObject({ wid: "W701", action: "close_done", detail: "outcome=closed_done" });
  });
});

describe("W1470 P2 through createStudioApp", () => {
  it("the armed switch settles the ghost during boot, before any turn runs", () => {
    const h = makeHarness({
      env: { CELESTEA_WORKER_RECOVER: "1" },
      rawFiles: { "worker-registry.tsv": ghostTable(), "worker-results/W701-ghost-a0.md": "report\n" },
    });
    harnesses.push(h);
    const table = join(h.root, "worker-registry.tsv");
    expect(rowOf(dirname(table), "W701").status).toBe("DONE");
    expect(rowOf(dirname(table), "W702").status).toBe("FAILED");
    expect(rowOf(dirname(table), "W703").status).toBe("RUNNING");
    expect(readFileSync(table, "utf8")).toContain("claimed=");
  });

  it("the default boot leaves the table exactly as the previous process wrote it", () => {
    const h = makeHarness({ env: {}, rawFiles: { "worker-registry.tsv": ghostTable(), "worker-results/W701-ghost-a0.md": "report\n" } });
    harnesses.push(h);
    expect(readFileSync(join(h.root, "worker-registry.tsv"), "utf8")).toBe(ghostTable());
  });
});
