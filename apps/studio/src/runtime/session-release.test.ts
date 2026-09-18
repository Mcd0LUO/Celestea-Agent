/**
 * W794 — `releaseSessionOf` 的**次序**单测（HTTP 真集成验收在
 * `delete-active-session.test.ts`；这里只把「先切断、再释放」的顺序与有界等待钉死，
 * 用一个手写的 registry 接缝，和仓库里既有的 `registryOf()` 同类）。
 */
import { describe, expect, it } from "vitest";
import type { SessionRuntime, SessionRuntimeRegistry } from "@celestea/runtime";
import { RELEASE_SETTLE_MS, releaseSessionOf, releaseSettleMs } from "./session-release.js";

/** 一个只被 release/peek 用到的最小实例记录。 */
function entry(inFlight: boolean): SessionRuntime {
  return {
    key: "ws/s1",
    sessionId: "ws/s1",
    dir: "/tmp/ws/s1",
    profileEpoch: 0,
    runtime: {} as SessionRuntime["runtime"],
    turnNo: 1,
    controller: null,
    inFlight,
    lastOutcome: null,
    lastActiveAt: 0,
    needsRebuild: false,
    detached: false,
  };
}

interface Built {
  calls: string[];
  deps: Parameters<typeof releaseSessionOf>[0];
}

function make(opts: { session?: SessionRuntime | null; settleMs?: number; onCancel?: () => void } = {}): Built {
  const calls: string[] = [];
  const session = "session" in opts ? (opts.session ?? null) : entry(false);
  const registry = {
    peek: (): SessionRuntime | null => session,
    release: async (): Promise<boolean> => {
      calls.push("release");
      return true;
    },
  } as unknown as SessionRuntimeRegistry;
  return {
    calls,
    deps: {
      registry,
      cancel: (): boolean => {
        calls.push("cancel");
        opts.onCancel?.();
        return true;
      },
      forget: async (): Promise<void> => void calls.push("forget"),
      settleMs: opts.settleMs ?? 50,
    },
  };
}

describe("W794 releaseSessionOf", () => {
  it("a running turn is CUT first, then the instance is dropped", async () => {
    const b = make({ session: entry(true) });
    expect(await releaseSessionOf(b.deps, "ws/s1")).toBe(true);
    expect(b.calls).toEqual(["cancel", "forget", "release"]);
  });

  it("an idle instance is dropped without an abort (nothing to cut)", async () => {
    const b = make({ session: entry(false) });
    expect(await releaseSessionOf(b.deps, "ws/s1")).toBe(true);
    expect(b.calls).toEqual(["forget", "release"]);
  });

  it("waits for the aborted turn, but the wait is bounded", async () => {
    const session = entry(true);
    // 结算在 50ms 后到达：release 必须等它，且顺序仍在 cancel 之后。
    // （10ms 与下方 `>= 10` 的断言同界，整机满负载时会量到 9ms 的假红；
    //   把结算时刻抬到 50ms 留出明确余量，断言本身不放宽。）
    const b = make({ session, settleMs: 500, onCancel: () => setTimeout(() => void (session.inFlight = false), 50) });
    const started = Date.now();
    expect(await releaseSessionOf(b.deps, "ws/s1")).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(b.calls).toEqual(["cancel", "forget", "release"]);

    // 永不结算的回合：等待到点也要释放（删除必须成功）。
    const stuck = make({ session: entry(true), settleMs: 20 });
    const t2 = Date.now();
    expect(await releaseSessionOf(stuck.deps, "ws/s1")).toBe(true);
    expect(Date.now() - t2).toBeLessThan(2_000);
    expect(stuck.calls).toEqual(["cancel", "forget", "release"]);
  });

  it("no instance: the autowake loop is still forgotten; the detached default is untouched", async () => {
    // W833 (R3 B7 / W816 F2): peek()===null means "no live instance", NOT "no
    // loop" — an idle-evicted session still has an autowake loop to unpark.
    const none = make({ session: null });
    expect(await releaseSessionOf(none.deps, "ws/s1")).toBe(false);
    expect(none.calls).toEqual(["forget"]);
    const def = make({ session: entry(true) });
    expect(await releaseSessionOf(def.deps, null)).toBe(false);
    expect(def.calls).toEqual([]);
  });

  it("the settle budget is the documented default unless the env overrides it", () => {
    expect(releaseSettleMs({})).toBe(RELEASE_SETTLE_MS);
    expect(releaseSettleMs({ CELESTEA_RELEASE_SETTLE_MS: "0" })).toBe(0);
    expect(releaseSettleMs({ CELESTEA_RELEASE_SETTLE_MS: "nonsense" })).toBe(RELEASE_SETTLE_MS);
  });
});
