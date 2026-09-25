/**
 * W1528b · terminateTree 必须有界（SIGTERM 不生效时升级 SIGKILL）
 *
 * 为什么单独有这条：`terminateTree` 原实现是
 *   `entry.child.terminate(); return entry.child.wait()`
 * —— 注释写着「the caller escalates to SIGKILL on the deadline」，**但没有任何 caller 这么做**。
 * 于是当 SIGTERM 不能收掉进程树时（shell 忽略 SIGTERM / `script` 不释放 pty），
 * close 请求**永不返回**：id 不摘、面板关不掉、也开不回来。
 * 这不是假想 —— 全量跑时 `tests/w1528-real-terminal.test.ts` 的
 * 「close reaps the WHOLE tree」用例超时 30s 抓到过（隔离跑 3/3 绿 ⇒ 负载相关）。
 *
 * 判据：用一个「SIGTERM 忽略、SIGKILL 才死」的假 child，
 * 断言 terminateTree 在 TERMINATE_GRACE_MS 内返回，且 kill() 被调用过。
 */
import { describe, expect, it } from "vitest";
import type { SandboxChild, SandboxExit } from "@celestea/core";

import { TERMINATE_GRACE_MS, terminateTree, type TerminalEntry } from "../apps/studio/src/handlers/terminal-pty.js";

/** A child that only settles when SIGKILLed — SIGTERM is ignored, as a real one may. */
function stubbornChild(): { child: SandboxChild; killed: () => boolean; terminated: () => boolean } {
  let settle: ((e: SandboxExit) => void) | null = null;
  let killed = false;
  let terminated = false;
  const wait = new Promise<SandboxExit>((resolve) => {
    settle = resolve;
  });
  const child: SandboxChild = {
    pid: 4242,
    stdin: null,
    stdout: null,
    stderr: null,
    wait: () => wait,
    terminate: () => {
      terminated = true;
      // Deliberately does NOT settle: this is the whole point.
    },
    kill: () => {
      killed = true;
      settle?.({ code: null, signal: "SIGKILL" });
    },
  };
  return { child, killed: () => killed, terminated: () => terminated };
}

function entryWith(child: SandboxChild): TerminalEntry {
  return { id: "t1", session: null, child, cols: 80, rows: 24, bytes: 0, touchedAt: 0, closed: false };
}

describe("W1528b · terminateTree is bounded", () => {
  it("escalates to SIGKILL when SIGTERM does not reap the tree", async () => {
    const { child, killed, terminated } = stubbornChild();
    const entry = entryWith(child);
    const started = Date.now();
    await terminateTree(entry);
    const elapsed = Date.now() - started;

    expect(terminated(), "SIGTERM is tried first (graceful path)").toBe(true);
    expect(killed(), "SIGKILL escalation must fire when SIGTERM is ignored").toBe(true);
    expect(entry.closed).toBe(true);
    // Bounded: it must not hang. Allow the full grace plus slack for CI.
    expect(elapsed).toBeLessThan(TERMINATE_GRACE_MS * 2 + 2_000);
  });

  it("returns promptly when SIGTERM already reaped the tree (no needless SIGKILL)", async () => {
    let killed = false;
    let settle: ((e: SandboxExit) => void) | null = null;
    const wait = new Promise<SandboxExit>((resolve) => {
      settle = resolve;
    });
    const child: SandboxChild = {
      pid: 4243,
      stdin: null,
      stdout: null,
      stderr: null,
      wait: () => wait,
      terminate: () => settle?.({ code: 0, signal: "SIGTERM" }),
      kill: () => {
        killed = true;
      },
    };
    const started = Date.now();
    await terminateTree(entryWith(child));
    expect(killed, "a graceful exit must not be escalated").toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
