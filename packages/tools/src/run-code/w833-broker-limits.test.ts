/**
 * W833 (R3 B1) — run_code hard wall clock + effective-config render.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B1: W812 P1-1 + A2 (慢 sub-call / 回复写满 pipe 越过 120s，可永久挂起) and
 * W812 P2-2 (composeRender 用模块常量而非 ctx.config).
 *
 * Every case drives the REAL broker harness (real sandbox + real registry
 * dispatch through the shared pipeline), never a private helper.
 */

import type { ToolExecOutcome } from "@celestea/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fnTool } from "../fn-tool.js";
import { ToolRegistryImpl } from "../registry.js";
import { runCodeToolWithHandle } from "../tools/run-code.js";
import { runCodeConfig } from "./limits.js";
import { echoSpec, startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

let h: BrokerHarness;
beforeAll(async () => {
  h = await startBrokerHarness();
});
afterAll(async () => {
  if (h !== undefined) await h.cleanup();
});

const skipTs = (): boolean => !h.nodeReady;

/** A registry whose run_shell is the injected slow/blocking double. */
function registryWithShell(shell: (args: unknown) => Promise<unknown>): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const name of ["read_file", "write_file", "list_dir"]) {
    registry.register(fnTool(echoSpec(name), async (args) => ({ echo: name, args })));
  }
  registry.register(fnTool(echoSpec("run_shell"), shell));
  return registry;
}

describe("B1 W812 P1-1: the wall clock is independent of the pump", () => {
  it("cuts a slow sub-call at the wall clock instead of waiting for it", async (ctx) => {
    // W891: a silent `return` counts as PASSED; make the missing interpreter a
    // visible skip (same condition, just reported honestly).
    if (skipTs()) {
      ctx.skip("the TypeScript runtime is unavailable inside the sandbox here");
      return;
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = registryWithShell(async () => {
      await gate;
      return { stdout: "", stderr: "", exit_code: 0, stdout_truncated: false, stderr_truncated: false };
    });
    const tool = h.mount(registry);
    const code = ["  const r = tools.run_shell({ command: 'sleep 30' });", "  return r;"].join("\n");
    const started = Date.now();
    // W896: 800ms is enough to prove "cut at the wall clock, not after the 30s sleep";
    // the original 2000ms bought nothing but a longer gate.
    const failure = (await h.run(tool, "rc-w833-slow", { code, timeout_ms: 800 }).catch((e: unknown) => e)) as Error;
    const elapsed = Date.now() - started;
    release();
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/^run_code: code=timeout /);
    expect(elapsed).toBeLessThan(2_500);
  }, 20_000);

  it("times out a reply the child refuses to drain (full pipe) instead of hanging", async (ctx) => {
    if (skipTs()) {
      ctx.skip("the TypeScript runtime is unavailable inside the sandbox here");
      return;
    }
    // W896: inject a 1s stdin-write bound instead of waiting out the real 5s default.
    // The property under test ("a reply the child never drains is a timeout, not a hang")
    // is unchanged; only the wall-clock constant is parameterised. The production default
    // is still 5s — nothing outside tests sets this.
    const tool = h.mount(h.echoRegistry(), { config: runCodeConfig({ stdinWriteTimeoutMs: 1_000 }) });
    const code = [
      "  const big = 'A'.repeat(200000);",
      '  process.stdout.write(JSON.stringify({ id: 1, tool: "read_file", args: { path: "/tmp/x.txt", content: big } }) + "\\n");',
      "  await new Promise((resolve) => setTimeout(resolve, 60000));",
      "  return null;",
    ].join("\n");
    const started = Date.now();
    const failure = (await h.run(tool, "rc-w833-write", { code }).catch((e: unknown) => e)) as Error;
    const elapsed = Date.now() - started;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/^run_code: code=timeout /);
    expect(failure.message).toContain("stopped reading stdin");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4_000);
    expect(await h.leftoverScripts()).toEqual([]);
  }, 20_000);
});

describe("B1 W812 P2-2: composeRender numbers come from the effective config", () => {
  it("reports the injected log/sub-output budgets, not the module constants", async (ctx) => {
    if (skipTs()) {
      ctx.skip("the TypeScript runtime is unavailable inside the sandbox here");
      return;
    }
    const registry = h.echoRegistry();
    const { tool, handle } = runCodeToolWithHandle({
      sandbox: h.sandbox,
      config: runCodeConfig({ maxLogBytes: 1_234, maxSubOutputBytes: 2_000 }),
    });
    registry.register(tool);
    handle.set(registry);
    const code = [
      '  console.log("L".repeat(4000));',
      '  const v = tools.read_file({ path: "/tmp/x.txt", content: "C".repeat(4000) });',
      '  return { ok: true };',
    ].join("\n");
    const out = (await h.run(tool, "rc-w833-render", { code })) as ToolExecOutcome;
    expect(out.value).toEqual({ ok: true });
    expect(out.render).toContain("stdout logs truncated at 1234 bytes");
    expect(out.render).toContain("sub-call output budget (2000 bytes) exceeded");
    expect(out.render).not.toContain("65536");
    expect(out.render).not.toContain("262144");
  });
});
