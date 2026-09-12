/**
 * W769 — the host auto-wake loop.
 *
 * The loop is a pure coordinator: a mailbox, a busy predicate and a single
 * `wake(input)` callback. These tests drive it with a REAL `SessionMailbox` and
 * a manual clock, so the four promises (only real enqueues notify, idle host
 * wakes with a labelled input, a busy host loses nothing, a rebuilt generation
 * rebinds) are asserted without sleeping.
 */

import { describe, expect, it } from "vitest";
import { SessionMailbox } from "@celestea/workers";
import {
  AUTOWAKE_BUSY_RETRY_MS,
  AutowakeLoop,
  ENV_AUTOWAKE,
  autowakeEnabled,
  autowakeInput,
} from "./autowake.js";

/** A manual clock: `advance()` runs everything due, so the loop never sleeps. */
function manualTiming(): {
  timing: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  advance: (ms: number) => Promise<void>;
  scheduled: () => number;
} {
  interface Job {
    at: number;
    fn: () => void;
    id: number;
  }
  let now = 0;
  let next = 1;
  const jobs = new Map<number, Job>();
  return {
    timing: {
      setTimeout: (fn, ms) => {
        const id = next++;
        jobs.set(id, { at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (handle) => {
        jobs.delete(handle as number);
      },
    },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...jobs.values()].filter((j) => j.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        jobs.delete(due.id);
        due.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      await Promise.resolve();
    },
    scheduled: () => jobs.size,
  };
}

/** A loop harness: real mailbox, stub wake, manual clock. */
function harness(options: { wake?: (input: string) => boolean } = {}) {
  const mailbox = new SessionMailbox(() => 0);
  const clock = manualTiming();
  const inputs: string[] = [];
  const logs: string[] = [];
  let busy = false;
  let current: SessionMailbox | null = mailbox;
  let accept = true;
  const loop = new AutowakeLoop(
    {
      queueKey: "cli-main",
      mailbox: () => current,
      isBusy: () => busy,
      wake: (input) => {
        inputs.push(input);
        return options.wake === undefined ? accept : options.wake(input);
      },
      log: (line) => logs.push(line),
    },
    { timing: clock.timing },
  );
  return {
    mailbox,
    clock,
    loop,
    inputs,
    logs,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setMailbox: (value: SessionMailbox | null) => {
      current = value;
    },
    failWake: () => {
      accept = false;
    },
    acceptWake: () => {
      accept = true;
    },
    settle: async (ms = 0) => {
      await clock.advance(ms);
      await Promise.resolve();
    },
  };
}

describe("autowake switch (W769)", () => {
  it("defaults ON and turns off on the four documented literals", () => {
    expect(ENV_AUTOWAKE).toBe("CELESTEA_AUTOWAKE");
    expect(autowakeEnabled({})).toBe(true);
    expect(autowakeEnabled({ [ENV_AUTOWAKE]: "" })).toBe(true);
    for (const off of ["0", "off", "false", "no", " OFF ", "False"]) {
      expect(autowakeEnabled({ [ENV_AUTOWAKE]: off }), off).toBe(false);
    }
    expect(autowakeEnabled({ [ENV_AUTOWAKE]: "yes" })).toBe(true);
  });

  it("labels every drained message with its sender, FIFO, blank-line separated", () => {
    const at = 0;
    expect(
      autowakeInput([
        { id: 1, to: "cli-main", content: "done", from_label: "W1", at, kind: "relay", source: { kind: "worker-relay", form: "message", senderSessionId: "W1" } },
        { id: 2, to: "cli-main", content: "bare", from_label: "", at, kind: "relay", source: { kind: "worker-relay", form: "message", senderSessionId: "" } },
      ]),
    ).toBe("[from W1] done\n\nbare");
  });
});

describe("AutowakeLoop (W769)", () => {
  it("wakes an IDLE host with the whole queue as one labelled input", async () => {
    const h = harness();
    h.loop.start();
    await h.settle();

    h.mailbox.send("cli-main", "report A", "W1");
    h.mailbox.send("cli-main", "report B", "W2");
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);

    expect(h.inputs).toEqual(["[from W1] report A\n\n[from W2] report B"]);
    expect(h.mailbox.pending("cli-main")).toBe(0);
    await h.loop.stop();
  });

  it("leaves the message QUEUED while the host is busy, then consumes it exactly once", async () => {
    const h = harness();
    h.setBusy(true);
    h.loop.start();
    await h.settle();
    h.mailbox.send("cli-main", "receipt", "W1");

    // Busy passes: never drained, never woken.
    for (let i = 0; i < 5; i += 1) await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);
    expect(h.inputs).toEqual([]);
    expect(h.mailbox.pending("cli-main")).toBe(1);

    h.setBusy(false);
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);
    expect(h.inputs).toEqual(["[from W1] receipt"]);
    expect(h.mailbox.pending("cli-main")).toBe(0);

    // …and nothing is consumed twice: more idle passes change nothing.
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS * 4);
    expect(h.inputs).toHaveLength(1);
    await h.loop.stop();
  });

  it("re-queues into the generation in force when the wake loses the race (no loss, no double consumption)", async () => {
    const h = harness();
    // Observe enqueues instead of draining: draining would race the loop itself.
    const enqueued: string[] = [];
    h.mailbox.onQueued((to, m) => {
      if (to === "cli-main") enqueued.push(`${m.from_label}:${m.content}:${m.kind}`);
    });
    h.loop.start();
    await h.settle();

    h.failWake();
    h.mailbox.send("cli-main", "receipt", "W1");
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);

    // The wake was refused, so the message went back into the queue, in order,
    // with its envelope intact (it is the same queue object, so a second
    // enqueue notification is expected).
    expect(h.inputs).toEqual(["[from W1] receipt"]);
    expect(enqueued).toEqual(["W1:receipt:relay", "W1:receipt:relay"]);
    expect(h.mailbox.pending("cli-main")).toBe(1);

    // Once the host accepts, the SAME message is consumed — exactly once.
    h.acceptWake();
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);
    expect(h.inputs).toHaveLength(2);
    expect(h.mailbox.pending("cli-main")).toBe(0);
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS * 4);
    expect(h.inputs).toHaveLength(2);
    await h.loop.stop();
  });

  it("rebinds to the NEW generation after a rebuild and wakes from IT", async () => {
    const h = harness();
    h.loop.start();
    await h.settle();

    // The instance is recomposed (config/grant epoch bump): a brand-new mailbox.
    const rebuilt = new SessionMailbox(() => 0);
    h.setMailbox(rebuilt);
    await Promise.resolve();
    rebuilt.send("cli-main", "after the swap", "W2");
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);

    expect(h.inputs).toEqual(["[from W2] after the swap"]);
    expect(rebuilt.pending("cli-main")).toBe(0);
    // The stale mailbox is not resurrected by the loop.
    expect(h.mailbox.pending("cli-main")).toBe(0);
    await h.loop.stop();
  });

  it("never throws and never spins when there is no generation to bind", async () => {
    const h = harness();
    h.setMailbox(null);
    h.loop.start();
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS);
    expect(h.inputs).toEqual([]);
    expect(h.logs.length).toBeGreaterThan(0);
    // Backoff, not a hot loop: passes are spaced, not immediate.
    const before = h.logs.length;
    await h.clock.advance(1);
    expect(h.logs.length).toBe(before);
    await h.loop.stop();
  });

  it("survives a throwing wake (logged, backed off, still alive)", async () => {
    let explode = true;
    const mailbox = new SessionMailbox(() => 0);
    const clock = manualTiming();
    const logs: string[] = [];
    const inputs: string[] = [];
    const loop = new AutowakeLoop(
      {
        queueKey: "cli-main",
        mailbox: () => mailbox,
        isBusy: () => false,
        wake: (input) => {
          inputs.push(input);
          if (explode) throw new Error("turn exploded");
          return true;
        },
        log: (line) => logs.push(line),
      },
      { timing: clock.timing },
    );
    loop.start();
    await Promise.resolve();
    mailbox.send("cli-main", "receipt", "W1");
    await clock.advance(AUTOWAKE_BUSY_RETRY_MS);
    expect(inputs).toHaveLength(1);
    expect(logs.some((l) => l.includes("turn exploded"))).toBe(true);

    explode = false;
    mailbox.send("cli-main", "second", "W2");
    await clock.advance(AUTOWAKE_BUSY_RETRY_MS);
    expect(inputs.at(-1)).toBe("[from W2] second");
    await loop.stop();
  });

  it("stops cleanly: no timers left, no further wakes", async () => {
    const h = harness();
    h.loop.start();
    await h.settle();
    expect(h.clock.scheduled()).toBeGreaterThan(0);
    await h.loop.stop();
    expect(h.clock.scheduled()).toBe(0);
    expect(h.loop.isStopped).toBe(true);
    h.mailbox.send("cli-main", "after-stop", "W1");
    await h.clock.advance(AUTOWAKE_BUSY_RETRY_MS * 4);
    expect(h.inputs).toEqual([]);
    await h.loop.stop(); // idempotent
  });
});
