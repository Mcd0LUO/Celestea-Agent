/**
 * `run_code` under the seccomp whitelist (W775).
 *
 * The default harness sandbox installs no filter, so this file builds its own
 * through the provider policy with `CELESTEA_SANDBOX_SECCOMP=1` and drives the
 * same real broker + registry pipeline. Every case is gated on the filter being
 * genuinely active (`/proc/self/status` reports `Seccomp: 2`), so the file stays
 * green on a host without bubblewrap while being a hard gate where it works.
 *
 * What W775 fixed: Node exits 0 but prints NOTHING under the old whitelist —
 * `uv_guess_handle()` could not classify socket-backed stdio (`getsockname` /
 * `getsockopt` were EPERM), so `process.stdout`/`stderr` were created without a
 * libuv handle and every write was dropped silently.
 */

import type { Tool, ToolExecOutcome } from "@celestea/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolRegistryImpl } from "../registry.js";
import { BWRAP_PROVIDER } from "../sandbox/bwrap-argv.js";
import { buildSandboxConfig } from "../sandbox/config.js";
import { ENV_SANDBOX_SECCOMP, selectSandboxDetailed } from "../sandbox/provider.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

let h: BrokerHarness | undefined;
let provider = "unset";
let seccompActive = false;

beforeAll(async () => {
  h = await startBrokerHarness({
    sandboxFor: (dir) => {
      const selection = selectSandboxDetailed({
        env: { ...process.env, [ENV_SANDBOX_SECCOMP]: "1" },
        config: buildSandboxConfig({ workdir: dir, root: dir, timeoutMs: 30_000, maxTimeoutMs: 120_000, maxOutputBytes: 64 * 1024 }),
      });
      provider = selection.provider;
      return selection.sandbox;
    },
  });
  const status = await h.sandbox.run({ command: "grep -E '^Seccomp:' /proc/self/status" });
  seccompActive = provider === BWRAP_PROVIDER && status.stdout.includes("Seccomp:\t2");
  if (!seccompActive) console.warn("[run_code] skip: the seccomp whitelist is not active on this host right now");
});

afterAll(async () => {
  if (h !== undefined) await h.cleanup();
});

const skip = (): boolean => !seccompActive || h === undefined;
const mount = (registry: ToolRegistryImpl): Tool => h!.mount(registry);
const run = (tool: Tool, callId: string, args: unknown): Promise<ToolExecOutcome> =>
  h!.run(tool, callId, args) as Promise<ToolExecOutcome>;

describe("run_code under the seccomp whitelist (W775)", () => {
  it("proves the filter is on before asserting anything else", () => {
    if (provider !== BWRAP_PROVIDER) return; // no bwrap here: the whole file is skipped
    expect(seccompActive).toBe(true);
  });

  it("round-trips the four bridges with TypeScript (default language)", async () => {
    if (skip() || !h!.nodeReady) return;
    const tool = mount(h!.echoRegistry());
    const code = `
      const file = await tools.read_file({ path: "/tmp/seccomp.txt" });
      const shell = tools.run_shell({ command: "printf seccomp-ok" });
      const dir = await tools.list_dir("/tmp");
      return { file: (file as any).echo, shell: (shell as any).args.command, dir: (dir as any).echo, node: process.version };
    `;
    const out = await run(tool, "rc-seccomp-ts", { code, description: "ts bridges under seccomp" });
    expect(out.value).toMatchObject({
      file: "read_file",
      shell: "printf seccomp-ok",
      dir: "list_dir",
    });
    expect(String((out.value as { node: string }).node)).toMatch(/^v\d+\./);
  });

  it("keeps the Python lane alive (asyncio self-pipe needs socketpair)", async () => {
    if (skip() || !h!.pythonReady) return;
    const tool = mount(h!.echoRegistry());
    const code = `
    import asyncio
    await asyncio.sleep(0.01)
    out = tools.read_file(path="/tmp/seccomp.txt")
    return {"echo": out["echo"], "loop": type(asyncio.get_running_loop()).__name__}
    `;
    const out = await run(tool, "rc-seccomp-py", { language: "python", code, description: "python bridges under seccomp" });
    expect(out.value).toEqual({ echo: "read_file", loop: "_UnixSelectorEventLoop" });
  });

  it("leaves no run_code_* script behind under the whitelist", async () => {
    if (skip() || !h!.nodeReady) return;
    const tool = mount(h!.echoRegistry());
    await run(tool, "rc-seccomp-clean", { code: "  return 1 + 1;", description: "cleanup under seccomp" });
    expect(await h!.leftoverScripts()).toEqual([]);
  });
});
