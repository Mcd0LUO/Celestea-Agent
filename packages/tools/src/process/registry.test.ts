/**
 * W6: the process registry keeps a BOUNDED tombstone for a finished process, so
 * `process_control(action=poll)` after exit still answers with the terminal state
 * (and a CPU-cap kill is marked), and so the live set stays bounded.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SandboxChild, SandboxExit } from "@celestea/core";

import { MAX_TOMBSTONES, ProcessRegistry, TOMBSTONE_TTL_MS } from "./registry.js";

const tick = (): Promise<void> => sleep(1);

/** A child whose wait() resolves with `exit` on the next tick. */
function childOf(exit: SandboxExit): { child: SandboxChild; kill: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  const kill = vi.fn();
  const terminate = vi.fn();
  const child = {
    pid: 4321,
    stdin: null,
    stdout: null,
    stderr: null,
    wait: () => Promise.resolve(exit),
    terminate,
    kill,
  } as unknown as SandboxChild;
  return { child, kill, terminate };
}

describe("W6 process tombstones", () => {
  it("answers poll AFTER exit with the terminal state instead of unknown handle", async () => {
    const reg = new ProcessRegistry();
    const { handle } = reg.insert(childOf({ code: 3, signal: null }).child);
    await tick();

    expect(reg.size).toBe(0); // no longer live...
    const out = reg.poll(handle); // ...but still answerable
    expect(out).toMatchObject({ ok: true, handle, running: false, exit_code: 3, signal: null });
  });

  it("records the terminating signal and marks an RLIMIT_CPU kill", async () => {
    const reg = new ProcessRegistry();
    const { handle } = reg.insert(childOf({ code: null, signal: "SIGXCPU" }).child, true, { cpuSec: 5 });
    await tick();

    const out = reg.poll(handle);
    expect(out).toMatchObject({ ok: true, running: false, exit_code: null, signal: "SIGXCPU", cpu_exceeded: true });
    expect(String(out["message"])).toContain("CPU time limit 5s exceeded");
  });

  it("does not mark a plain (non-CPU) exit", async () => {
    const reg = new ProcessRegistry();
    const { handle } = reg.insert(childOf({ code: 0, signal: null }).child, true, { cpuSec: 5 });
    await tick();
    expect(reg.poll(handle)["cpu_exceeded"]).toBeUndefined();
  });

  it("tells kill/stdin that an exited process is gone (not unknown)", async () => {
    const reg = new ProcessRegistry();
    const { handle } = reg.insert(childOf({ code: 7, signal: null }).child);
    await tick();
    await expect(reg.kill(handle)).resolves.toMatchObject({ ok: false });
    await expect(reg.kill(handle)).resolves.toMatchObject({ error: expect.stringContaining("already exited") });
    await expect(reg.stdinLine(handle, "x")).resolves.toMatchObject({ ok: false, error: expect.stringContaining("already exited") });
  });

  it("evicts the oldest terminal records past the count cap", async () => {
    let now = 1_000;
    const reg = new ProcessRegistry({ maxTombstones: 2, now: () => now });
    const handles: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      handles.push(reg.insert(childOf({ code: i, signal: null }).child).handle);
      await tick();
      now += 1;
    }
    // The oldest is gone; the two most recent are still pollable.
    expect(reg.poll(handles[0]!)).toMatchObject({ ok: false, error: expect.stringContaining("unknown handle") });
    expect(reg.poll(handles[1]!).ok).toBe(true);
    expect(reg.poll(handles[2]!).ok).toBe(true);
  });

  it("evicts a terminal record past its TTL", async () => {
    let now = 1_000;
    const reg = new ProcessRegistry({ tombstoneTtlMs: 100, now: () => now });
    const { handle } = reg.insert(childOf({ code: 0, signal: null }).child);
    await tick();
    expect(reg.poll(handle).ok).toBe(true);
    now += 200;
    expect(reg.poll(handle)).toMatchObject({ ok: false, error: expect.stringContaining("unknown handle") });
  });

  it("pins the default bounds (32 records / 10 minutes)", () => {
    expect(MAX_TOMBSTONES).toBe(32);
    expect(TOMBSTONE_TTL_MS).toBe(10 * 60 * 1_000);
  });

  it("killAll clears tombstones too (shutdown leaks nothing)", async () => {
    const reg = new ProcessRegistry();
    const { handle } = reg.insert(childOf({ code: 0, signal: null }).child);
    await tick();
    expect(reg.poll(handle).ok).toBe(true);
    reg.killAll();
    expect(reg.poll(handle)).toMatchObject({ ok: false });
  });
});
