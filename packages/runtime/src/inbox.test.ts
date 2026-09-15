/**
 * The injection queue's two P1 properties (iteration E §1.3 P1 ① / §2.2.3):
 *
 *   - the lanes and the accepted-id ledger PERSIST through a sink, so a message
 *     that was accepted but not yet injected survives a crash (G1-4) and a
 *     receipt's cross-process idempotency key survives a restart (B3);
 *   - the duplicate rule is unchanged by all of that: the same id is accepted
 *     exactly once, whichever process accepted it first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore, checkpointedLog, PersistentSessionLog } from "@celestea/session";
import { compose } from "./compose.js";
import { testProfile } from "./fakes.test-util.js";
import { createSessionInbox, type InboxSnapshot } from "./inbox.js";
import type { Runtime } from "./runtime.js";
import { checkpointInboxSink } from "./inbox-checkpoint.js";

const SESSION = "ws/s1";
const IDENTITY = { boot_id: "b-00000001", pid: 777 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function store(): CheckpointStore {
  const dir = mkdtempSync(join(tmpdir(), "inbox-ckpt-"));
  roots.push(dir);
  return new CheckpointStore({ dir, session: SESSION, identity: IDENTITY, now: () => 1_700_000_000 });
}

describe("inbox persistence (E §1.3 P1 ①)", () => {
  it("persists both lanes + the delivered ledger, and restores them silently", () => {
    const first = store();
    const inbox = createSessionInbox(() => 1, {});
    inbox.bindPersistence(checkpointInboxSink(first));
    inbox.push("排队等我下一轮", "next-turn", { id: "mailbox:7" });
    inbox.push("插一句话", "next-step", { id: "mailbox:8", from: "session-0" });

    // A NEW process (a new store over the same directory) restores both lanes…
    const restored = createSessionInbox(() => 2, { onQueued: () => { throw new Error("restore must be silent"); } });
    restored.bindPersistence(checkpointInboxSink(store2(first)));
    expect(restored.pending("next-turn")).toBe(1);
    expect(restored.pending("next-step")).toBe(1);
    const taken = restored.drain("next-turn");
    expect(taken.map((m) => m.text)).toEqual(["排队等我下一轮"]);
    expect(taken[0]?.id).toBe("mailbox:7");
    // …and the id is still remembered, so a replay across the restart is a duplicate.
    expect(restored.push("排队等我下一轮", "next-turn", { id: "mailbox:7" }).duplicate).toBe(true);
  });

  it("B3: one receipt key is injected exactly ONCE, in process and across processes", () => {
    const inbox = createSessionInbox(() => 1, {});
    inbox.bindPersistence(checkpointInboxSink(store()));
    const first = inbox.push("WORKER_W1_DONE 报告 results/W1-x-a1.md", "next-turn", { id: "receipt:W1:1", kind: "receipt" });
    const again = inbox.push("WORKER_W1_DONE 报告 results/W1-x-a1.md", "next-turn", { id: "receipt:W1:1", kind: "receipt" });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(inbox.pending()).toBe(1);
    // The NEXT attempt of the same wid is a DIFFERENT key: it must get through.
    const attempt2 = inbox.push("WORKER_W1_DONE 报告 results/W1-x-a2.md", "next-turn", { id: "receipt:W1:2", kind: "receipt" });
    expect(attempt2.duplicate).toBe(false);
    expect(inbox.pending()).toBe(2);
  });

  it("drains persist too: the queue on disk shrinks with the lane", () => {
    const first = store();
    const sink = checkpointInboxSink(first);
    const inbox = createSessionInbox(() => 1, {});
    inbox.bindPersistence(sink);
    inbox.push("a", "next-turn", { id: "mailbox:1" });
    inbox.push("b", "next-turn", { id: "mailbox:2" });
    inbox.drain("next-turn");
    const restored = createSessionInbox(() => 2, {});
    restored.bindPersistence(checkpointInboxSink(first));
    expect(restored.pending()).toBe(0);
    // The ledger keeps both ids (dedup memory is not the queue).
    expect(first.persistedQueues()?.delivered_ids).toEqual(["mailbox:1", "mailbox:2"]);
  });

  it("a sink that cannot be read leaves an EMPTY queue instead of failing", () => {
    const broken = { load: (): InboxSnapshot | null => { throw new Error("unreadable"); }, save: (): void => {} };
    const inbox = createSessionInbox(() => 1, {});
    expect(() => inbox.bindPersistence(broken)).not.toThrow();
    expect(inbox.pending()).toBe(0);
    // It still accepts new messages (the failure was in the PAST state, not in us).
    expect(inbox.push("x", "next-turn", { id: "mailbox:1" }).duplicate).toBe(false);
  });
});

/** A second store over the SAME directory (the restart, in one process). */
function store2(original: CheckpointStore): CheckpointStore {
  return new CheckpointStore({ dir: join(original.path, ".."), session: SESSION, identity: { boot_id: "b-00000002", pid: 778 } });
}

describe("compose(): the composer wires the sink (E §1.3 P1 ①)", () => {
  it("a checkpointed session log persists the queues, and a RE-compose restores them", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-inbox-"));
    roots.push(dir);
    const composed = (): Runtime =>
      compose({
        profile: testProfile(),
        sessionBinding: { sessionId: "ws/s1", dir, open: () => checkpointedLog(PersistentSessionLog.open(dir, "cli-main"), new CheckpointStore({ dir, session: "ws/s1", identity: IDENTITY })) },
        workers: false,
      });
    const first = composed();
    first.inject("排队等我下一轮", "next-turn", { id: "mailbox:7" });
    const second = composed();
    expect(second.pendingInjections("next-turn")).toBe(1);
  });
});
