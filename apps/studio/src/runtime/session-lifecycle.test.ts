/**
 * W825 P0 — a compaction must never rewrite the log of a PINNED session.
 *
 * Reproduces, at the FILE level, the chain the W816 audit found and W822 R2
 * verified: a session with LIVE worker work is pinned, so `SessionRuntimeRegistry
 * .evict` refuses it; `compactSession` used to discard that verdict, run the
 * real atomic rename and then report `rebound:true` — while the live
 * `PersistentSessionLog` descriptor kept pointing at the unlinked old inode, so
 * every later turn event went nowhere. The probe is derived from the W822 R2
 * verification of W816-F1 (there was no /tmp script for it; this is the
 * behavioural counterpart of the code-chain evidence).
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { PersistentSessionLog } from "@celestea/session";
import { SESSION_LOG_ID, SessionRuntimeRegistry, serializeEventLog, type Runtime } from "@celestea/runtime";
import { compactSession, PINNED_NOTE } from "./session-lifecycle.js";

const SESSION = "sample-ws/s1";
const LOG = "cli-main.jsonl";

/** 9 complete turns — one more than COMPACT_THRESHOLD (8), so compaction plans. */
function nineTurns(): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let n = 1; n <= 9; n++) {
    events.push({ type: "turn_start", id: `turn-${n}` });
    events.push({ type: "user_message", text: `问 ${n}` });
    events.push({ type: "assistant_message", text: `答 ${n}` });
    events.push({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
  }
  return events;
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "celestea-w825-compact-"));
  writeFileSync(join(dir, LOG), serializeEventLog(nineTurns()));
  return dir;
}

/** A registry whose instances are REAL persistent logs (a real append fd). */
function logRegistry(dir: string, pinned: boolean): SessionRuntimeRegistry {
  return new SessionRuntimeRegistry({
    build: (_sessionId, targetDir) => ({ session: PersistentSessionLog.open(targetDir ?? dir, SESSION_LOG_ID) }) as unknown as Runtime,
    dispose: (runtime) => (runtime.session as PersistentSessionLog).close(),
    ...(pinned ? { pinned: () => true } : {}),
  });
}

describe("W825 P0: compact refuses a pinned session and never orphans its log fd", () => {
  it("leaves the log byte-identical and keeps the live descriptor valid", async () => {
    const dir = makeDir();
    const registry = logRegistry(dir, true); // pinned exactly like production: live worker work
    const before = readFileSync(join(dir, LOG), "utf8");
    const live = registry.ensure(SESSION, dir);

    const out = await compactSession({ registry, resolve: () => ({ sessionId: SESSION, dir }), summarizer: () => async () => "摘要" }, SESSION);

    // Refused: nothing compacted, nothing rebound, a reason the caller can read.
    expect(out.compacted).toBe(false);
    expect(out.rebound).toBe(false);
    expect(out.note).toBe(PINNED_NOTE);
    // The atomic rename never ran: the log is byte-for-byte what it was, and no
    // pre-compaction backup was produced.
    expect(readFileSync(join(dir, LOG), "utf8")).toBe(before);
    expect(existsSync(join(dir, `${LOG}.precompact`))).toBe(false);
    // The instance was NOT rebuilt, and its open descriptor still points at the
    // LIVE file: an append made through it is visible on disk. Before the fix the
    // rename orphaned this descriptor and this assertion failed.
    expect(registry.peek(SESSION)?.runtime).toBe(live.runtime);
    live.runtime.session.append({ type: "assistant_message", text: "still-here" });
    expect(readFileSync(join(dir, LOG), "utf8")).toContain("still-here");
  });

  it("reports rebound:true only after a genuinely new instance is composed", async () => {
    const dir = makeDir();
    const registry = logRegistry(dir, false);
    const before = registry.ensure(SESSION, dir);

    const out = await compactSession({ registry, resolve: () => ({ sessionId: SESSION, dir }), summarizer: () => async () => "摘要" }, SESSION);

    expect(out.compacted).toBe(true);
    expect(out.rebound).toBe(true);
    // The claim is backed by a real rebuild: a DIFFERENT runtime instance.
    const after = registry.peek(SESSION)?.runtime;
    expect(after).not.toBe(before.runtime);
    // …and the instance replays the compacted file (summary head + kept turns).
    const events = (after as unknown as { session: PersistentSessionLog }).session.events();
    expect(events.some((e) => e.type === "user_message" && e.text.startsWith("【上下文压缩】"))).toBe(true);
  });
});
