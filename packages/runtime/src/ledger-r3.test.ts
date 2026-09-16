/**
 * W836 R3 batch F — ledger accounting / view / memory.
 *
 * Probes taken verbatim from the authoritative plan
 * `/server-center/runtime/worker-exec/results/W826-R3修复计划-A-core-llm-runtime.md`
 * (§三 批次 F):
 *   - P1-3: a failed first write must not poison the rest of the turn;
 *   - P2-5: the idempotency-key set is bounded (evicted per closed turn);
 *   - P2-2: the cumulative views include the rolled `.1` segment after rotation.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Usage } from "@celestea/core";
import {
  USAGE_LEDGER_FILE,
  UsageLedgerFile,
  createUsageLedger,
  ledgerKey,
  type UsageStepRecord,
} from "./ledger.js";
import { memoryLog } from "./fakes.test-util.js";

const roots: string[] = [];
const NOW = 1_760_000_000_000;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ledger-r3-"));
  roots.push(root);
  return root;
}

function usage(prompt: number, completion: number): Usage {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cache_read: 0, reasoning_tokens: 0 };
}

interface Rig {
  file: UsageLedgerFile;
  ledger: ReturnType<typeof createUsageLedger>;
  log: ReturnType<typeof memoryLog>;
  id: string;
  book(prompt: number): void;
}

/** One ledger over an OPEN turn, whose `book()` books a single ok step. */
function openTurn(dir: string, maxBytes?: number): Rig {
  const file = new UsageLedgerFile({ path: join(dir, USAGE_LEDGER_FILE), now: () => NOW, ...(maxBytes === undefined ? {} : { maxBytes }) });
  const ledger = createUsageLedger({ session: "ws/s1", file });
  const log = memoryLog();
  const id = log.nextTurnId();
  log.append({ type: "turn_start", id });
  ledger.beginTurn(log);
  const book = (prompt: number): void => {
    const handle = ledger.beginStep({ provider: "mock", model: "deepseek-chat", base_url_host: null, attempt: 0, fallback_from: null });
    handle.record(usage(prompt, 1));
    handle.close({ kind: "ok" });
  };
  return { file, ledger, log, id, book };
}

function steps(file: UsageLedgerFile): UsageStepRecord[] {
  return file.read().filter((r): r is UsageStepRecord => r.kind !== "turn_total");
}

describe("P1-3: a first write failure does not poison the turn", () => {
  it("books every later step once the directory exists, with increasing step numbers", () => {
    const root = tmpDir();
    const dir = join(root, "created-late");
    const r = openTurn(dir);

    r.book(10); // the directory is missing: openSync fails and the row is lost
    expect(existsSync(join(dir, USAGE_LEDGER_FILE))).toBe(false);
    expect(r.file.keyCount).toBe(0);

    mkdirSync(dir, { recursive: true });
    r.book(20);
    r.book(30);
    r.log.append({ type: "turn_end", id: r.id, outcome: "completed" });
    r.ledger.endTurn("completed");

    const rows = steps(r.file);
    expect(rows.map((row) => row.step)).toEqual([2, 3]);
    expect(new Set(rows.map((row) => ledgerKey(row))).size).toBe(2);
    const total = r.file.read().find((row) => row.kind === "turn_total");
    if (total?.kind !== "turn_total") throw new Error("no turn_total row");
    expect(total.steps).toBe(2);
    expect(total.attempts).toBe(2);
    expect(total.usage.prompt_tokens).toBe(50);
  });
});

describe("P2-5: the idempotency-key set is bounded", () => {
  it("remembers an in-flight turn key but evicts it when the turn closes", () => {
    const r = openTurn(tmpDir());
    r.book(10);
    expect(r.file.keyCount).toBe(1);
    const row = steps(r.file)[0];
    if (row === undefined) throw new Error("no step row");
    expect(r.file.append(row, ledgerKey(row))).toBe(false); // still deduped in flight
    r.log.append({ type: "turn_end", id: r.id, outcome: "completed" });
    r.ledger.endTurn("completed");
    expect(r.file.keyCount).toBe(0);
  });

  it("stays bounded across many complete turns", () => {
    const file = new UsageLedgerFile({ path: join(tmpDir(), USAGE_LEDGER_FILE), now: () => NOW });
    for (let turn = 0; turn < 50; turn++) {
      const ledger = createUsageLedger({ session: "ws/s1", file });
      const log = memoryLog();
      const id = log.nextTurnId();
      log.append({ type: "turn_start", id });
      ledger.beginTurn(log);
      const handle = ledger.beginStep({ provider: null, model: "m", base_url_host: null, attempt: 0, fallback_from: null });
      handle.record(usage(10, 1));
      handle.close({ kind: "ok" });
      log.append({ type: "turn_end", id, outcome: "completed" });
      ledger.endTurn("completed");
    }
    expect(file.keyCount).toBe(0);
    expect(steps(file)).toHaveLength(50);
  });
});

describe("P2-2: the cumulative views include the rolled segment", () => {
  it("counts `.1` in total()/latest() while read() stays current-only", () => {
    const r = openTurn(tmpDir(), 1);
    r.book(100);
    expect(r.ledger.total().prompt_tokens).toBe(100);
    r.book(200); // the first row rolls to <path>.1
    expect(r.ledger.total().prompt_tokens).toBe(300);
    expect(r.ledger.latest().prompt_tokens).toBe(200);
    expect(steps(r.file)).toHaveLength(1);
    expect(r.file.readAll().filter((rec) => rec.kind !== "turn_total")).toHaveLength(2);
    expect(readFileSync(`${r.file.path}.1`, "utf8")).toContain(String.raw`"step":1`);
  });
});
