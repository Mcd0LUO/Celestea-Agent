/**
 * W836 R3 batch I — the compaction rewrite durability contract (P2-6).
 *
 * Probe from the authoritative plan
 * `/server-center/runtime/worker-exec/results/W826-R3修复计划-A-core-llm-runtime.md`
 * (§三 批次 I): the real `runCompaction` path must fsync BOTH the tmp file and
 * the parent DIRECTORY after the rename. A power loss is not reproducible in a
 * test, so the probe spies on `node:fs` and asserts the two syscalls.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { COMPACT_THRESHOLD, COMPACT_TMP_PREFIX, runCompaction, serializeEventLog } from "./index.js";

const h = vi.hoisted(() => ({ opened: new Map<number, string>(), fsynced: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: string, ...rest: unknown[]) => {
      const fd = (actual.openSync as unknown as (p: string, ...r: unknown[]) => number)(path, ...rest);
      h.opened.set(fd, String(path));
      return fd;
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      h.fsynced.push(h.opened.get(fd) ?? "?");
      actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
  };
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function completeTurn(n: number): SessionEvent[] {
  const id = `turn-${n}`;
  return [
    { type: "turn_start", id },
    { type: "user_message", text: `q${n}` },
    { type: "assistant_message", text: `a${n}` },
    { type: "turn_end", id, outcome: "completed" },
  ];
}

describe("P2-6: rewriteAtomic fsyncs the parent directory", () => {
  it("fsyncs both the tmp file and the dirname on the real runCompaction path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r3-compact-"));
    roots.push(dir);
    const path = join(dir, "cli-main.jsonl");
    const events: SessionEvent[] = [];
    for (let n = 0; n <= COMPACT_THRESHOLD; n++) events.push(...completeTurn(n));
    writeFileSync(path, serializeEventLog(events));

    h.opened.clear();
    h.fsynced.length = 0;
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要") });
    expect(out.compacted).toBe(true);

    expect(h.fsynced).toContain(dir);
    expect(h.fsynced.some((p) => p.startsWith(join(dir, COMPACT_TMP_PREFIX)))).toBe(true);
  });
});
