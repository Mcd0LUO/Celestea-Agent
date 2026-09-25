/**
 * W1516 §3.3 — the `run_code` child's CPU budget.
 *
 * The bug this pins: `spawnProgram` used to call `sandbox.spawn({ command })`
 * with NO `cpuSec`, so the program silently inherited the provider's base
 * `DEFAULT_LIMITS.cpuSec` (20s) while the broker's own wall clock was 120s. A
 * perfectly ordinary long program died at 20s, far before its deadline, and the
 * failure carried no `cpu_exceeded` marker.
 *
 * A4 asserts what the broker ASKS the sandbox for (the derived value), which is
 * the half that was missing entirely; the fake sandbox records the request.
 */
import { describe, expect, it, vi } from "vitest";

import { createFakeSandbox } from "../sandbox/fake-sandbox.js";
import { deriveCpuSecFromWallClock } from "../sandbox/limits.js";
import { ToolRegistryImpl } from "../registry.js";
import { fnTool } from "../fn-tool.js";
import { RegistryHandle, runCodeToolWithHandle } from "../tools/run-code.js";
import { runCodeConfig } from "./limits.js";

/** The protocol line that ends a broker run cleanly (no interpreter needed). */
const FINAL_LINE = '{"__final__":1}\n';

/** A registry whose only whitelisted tool echoes — enough to mount run_code. */
function echoRegistry(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  registry.register(
    fnTool(
      {
        name: "read_file",
        description: "echo",
        parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      },
      async () => ({ ok: true }),
    ),
  );
  return registry;
}

/** Mount `run_code` on a fake sandbox whose child emits a final line and exits. */
function mountOn(sandbox: ReturnType<typeof createFakeSandbox>, timeoutMs = 120_000) {
  const registry = echoRegistry();
  const { tool, handle } = runCodeToolWithHandle({ sandbox, config: runCodeConfig({ timeoutMs }) });
  registry.register(tool);
  handle.set(registry);
  return tool;
}

/**
 * Run one program to completion on a fake sandbox and hand the sandbox back.
 *
 * The child emits a valid `__final__` line, so the broker finishes through its
 * NORMAL path — the assertion is about the spawn, and a clean exit keeps the test
 * free of incidental rejection noise.
 */
async function spawnWith(options: { args?: Record<string, unknown>; maxCpuSec?: number; timeoutMs?: number } = {}) {
  const sandbox = createFakeSandbox({
    config: { maxCpuSec: options.maxCpuSec ?? 600 },
    scripts: [{ stdout: [FINAL_LINE] }],
    fallback: { stdout: [FINAL_LINE] },
  });
  const tool = mountOn(sandbox, options.timeoutMs ?? 120_000);
  await tool.executeWith!({ call_id: "w1516", name: "run_code", args: { code: "return 1", ...(options.args ?? {}) } });
  return sandbox;
}

describe("W1516 A4 · run_code passes a derived cpuSec to the sandbox", () => {
  it("A4: the spawn carries ceil(timeout_ms/1000) + CPU_GRACE_SEC, not the provider default", async () => {
    const sandbox = await spawnWith({ args: { timeout_ms: 120_000 }, maxCpuSec: 600 });

    expect(sandbox.spawns).toHaveLength(1);
    const sent = sandbox.spawns[0]!.request.cpuSec;
    // 120s wall clock -> 125s CPU. Before §3.3 this was `undefined` (=> 20s).
    expect(sent).toBe(125);
    expect(sent).toBe(deriveCpuSecFromWallClock(120_000, 600));
    expect(sent).not.toBe(20);
  });

  it("A4: a shorter timeout_ms yields a proportionally smaller CPU budget", async () => {
    const sandbox = await spawnWith({ args: { timeout_ms: 30_000 }, maxCpuSec: 600 });
    expect(sandbox.spawns[0]!.request.cpuSec).toBe(35);
  });

  it("A4: the DEFAULT wall clock (120s, no timeout_ms) also derives", async () => {
    const sandbox = await spawnWith({ maxCpuSec: 600 });
    expect(sandbox.spawns[0]!.request.cpuSec).toBe(125);
  });

  it("A4: the derived value is clamped by the sandbox's own maxCpuSec", async () => {
    // A 120s wall clock under a 60s ceiling: the ceiling wins, as everywhere else.
    const sandbox = await spawnWith({ args: { timeout_ms: 120_000 }, maxCpuSec: 60 });
    expect(sandbox.spawns[0]!.request.cpuSec).toBe(60);
  });

  it("A4: the request carries the derived cpuSec and nothing else", async () => {
    // The model-facing surface deliberately has NO cpu_sec knob (§8): the
    // derivation is the only thing that may set it on a run_code child.
    const sandbox = await spawnWith({ args: { timeout_ms: 60_000 }, maxCpuSec: 600 });
    expect(Object.keys(sandbox.spawns[0]!.request).sort()).toEqual(["command", "cpuSec"]);
  });
});

describe("W1516 §3.3 · run_code names the CPU limit when it is what killed the program", () => {
  it("reports code=cpu_exceeded naming the limit instead of a bare aborted", async () => {
    // A child that never exits on its own and dies on SIGKILL with no final line
    // is exactly what an exhausted RLIMIT_CPU looks like from the broker.
    const sandbox = createFakeSandbox({
      config: { maxCpuSec: 600 },
      scripts: [{ exitAfterMs: Infinity }],
      fallback: { exitAfterMs: Infinity },
    });
    const tool = mountOn(sandbox, 60_000);

    const running = tool.executeWith!({ call_id: "w1516-cpu", name: "run_code", args: { code: "return 1" } });
    // Normalize the rejection into a resolved Error so the assertion below reads
    // an `Error` and never a `ToolExecOutcome` (a success here is itself a bug).
    const failure: Promise<Error> = running.then(
      () => new Error("expected a cpu_exceeded failure, but the run succeeded"),
      (e: unknown) => e as Error,
    );
    // Wait for the broker to REACH the spawn — never a fixed sleep.
    //
    // W1523: this used to be `await setTimeout(20)`, which is the same class of
    // bug AGENT.md §6 records for tests/w795-optimistic-grants.test.ts: a fixed
    // delay guesses how long another task needs. It passed on the 28-core Linux
    // box and failed on the Windows CI box with
    // `TypeError: Cannot read properties of undefined (reading 'child')` —
    // i.e. the broker had not spawned yet, so spawns[0] did not exist. Waiting
    // for the condition itself is bounded, deterministic, and returns as soon as
    // it holds (normal path: immediately).
    await vi.waitFor(() => {
      expect(sandbox.spawns.length, "broker must reach sandbox.spawn").toBeGreaterThan(0);
    }, { timeout: 5_000 });
    sandbox.spawns[0]!.child.kill();

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^run_code: code=cpu_exceeded /);
    // The message must NAME the limit (60s + 5s grace = 65) so the model can act.
    expect(error.message).toContain("CPU time limit 65s");
    expect(error.message).toContain("raise timeout_ms");
  });

  it("keeps the pre-existing fail-closed wiring (unbound handle)", async () => {
    const sandbox = createFakeSandbox({ config: { maxCpuSec: 600 } });
    const tool = runCodeToolWithHandle({ sandbox, config: runCodeConfig({}) }).tool;
    await expect(tool.executeWith!({ call_id: "x", name: "run_code", args: { code: "return 1" } })).rejects.toThrow(
      /code=registry/,
    );
    expect(RegistryHandle).toBeDefined();
  });
});
