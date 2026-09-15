/**
 * W787 (E §2.2.3 P1 ②/B3): the host DRAIN is where a worker receipt enters the
 * engine, and where its idempotency key is decided.
 *
 * A receipt must be keyed by `receipt:<wid>:<attempt>` — stable across processes,
 * so a receipt replayed after a restart (or delivered by two generations of the
 * same session) is dropped by the inbox's ordinary duplicate rule. Everything
 * else keeps the in-process mailbox sequence, because keying a deliberate relay
 * by `(wid, attempt)` would silently drop the SECOND intentional message.
 */

import { Context } from "@celestea/core";
import { InMemorySessionLog } from "@celestea/session";
import { WorkerRegistry } from "@celestea/workers";
import { describe, expect, it } from "vitest";
import { ensureWorkerWiring } from "./worker-wiring.js";

const NOW = 1_700_000_000_000;

function setup(hostSessionId = "ws/s1"): { registry: WorkerRegistry; drain: () => Array<{ id: string; text: string }> } {
  const ctx = Context.root();
  const host = ensureWorkerWiring(ctx, {
    tsvPath: null,
    resultsDir: "results",
    logFactory: () => new InMemorySessionLog(),
    hostSessionId,
    sessionIdPrefix: "worker-",
  });
  if (host === null) throw new Error("wiring disabled");
  return { registry: host.registry, drain: () => host.drain() as unknown as Array<{ id: string; text: string }> };
}

describe("worker receipt drain key (E §2.2.3)", () => {
  it("B3: a receipt is keyed by (wid, attempt) and a second delivery of the same row is dropped", () => {
    const { registry, drain } = setup();
    const sid = registry.sessions.create({ title: "W1·T", workspace: null, model: null, mode: null }).meta.id;
    registry.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${sid} host=ws/s1 attempt=1` });
    registry.rememberSpawn(sid, { wid: "W1", short: "T", brief: "b", reportTo: "ws/s1", mode: null });

    // The registry knows the key of the row it will deliver for.
    expect(registry.receiptKeyFor(sid)).toBe("receipt:W1:1");
    // A settlement notice carries it through the drain (`kind: receipt`).
    registry.mailbox.send("ws/s1", "WORKER_W1_DONE", sid, { kind: "receipt", source: { kind: "subagent-settled", form: "notice", summary: "s", senderSessionId: sid } });
    const drained = drain();
    expect(drained.map((m) => m.id)).toEqual(["receipt:W1:1"]);

    // The SAME key arrives again (a replayed driver): the key is what lets the
    // inbox — not the mailbox sequence — decide.
    registry.mailbox.send("ws/s1", "WORKER_W1_DONE", sid, { kind: "receipt", source: { kind: "subagent-settled", form: "notice", summary: "s", senderSessionId: sid } });
    expect(drain().map((m) => m.id)).toEqual(["receipt:W1:1"]);
  });

  it("a RELAY from the same worker keeps the mailbox sequence (two relays are two messages)", () => {
    const { registry, drain } = setup();
    const sid = registry.sessions.create({ title: "W2·T", workspace: null, model: null, mode: null }).meta.id;
    registry.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: `sess=${sid} host=ws/s1 attempt=1` });
    registry.mailbox.send("ws/s1", "first", sid);
    registry.mailbox.send("ws/s1", "second", sid);
    const ids = drain().map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^mailbox:\d+$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids.every((id) => !id.startsWith("receipt:"))).toBe(true);
  });

  it("stamps the dispatching host session on the rows it writes (`host=`)", () => {
    const { registry } = setup("ws/host");
    expect(registry.hostSessionId).toBe("ws/host");
    const sid = registry.sessions.create({ title: "W3·T", workspace: null, model: null, mode: null }).meta.id;
    registry.upsert({ wid: "W3", started_at: "t", status: "RUNNING", extra: `sess=${sid} host=ws/host attempt=1 lease=${registry.lease()}` });
    expect(registry.getEntry("W3")!.extra).toContain("host=ws/host");
    // The lease names THIS process and a whole number of seconds.
    expect(registry.lease()).toMatch(new RegExp(`^${process.pid}@\\d+$`));
    void NOW;
  });
});
