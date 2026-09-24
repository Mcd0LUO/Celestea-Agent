/**
 * W6: a CPU-cap kill must be OBSERVABLE in the foreground result, not a bare
 * death. The mapping lives in run_shell (signal + the provider's cpu_sec).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxRunResult } from "@celestea/core";

import { ProcessRegistry } from "../process/registry.js";
import { runShellTool } from "./run-shell.js";

function stubSandbox(result: Partial<SandboxRunResult>): Sandbox {
  const config = {
    timeoutMs: 1000,
    maxTimeoutMs: 1000,
    maxCpuSec: 600,
    maxOutputBytes: 1024,
    // W891: "/tmp" is POSIX-only; the host temp dir exists everywhere.
    workdir: tmpdir(),
    root: tmpdir(),
    programDir: join(tmpdir(), "run-code"),
    extraEnv: [] as ReadonlyArray<readonly [string, string]>,
  };
  const base: SandboxRunResult = {
    stdout: "",
    stderr: "",
    exit_code: 0,
    signal: null,
    stdout_truncated: false,
    stderr_truncated: false,
    sandbox: { provider: "raw", net_isolated: false, tmp_private: false, seccomp: false, enforcement: "partial", promise_gaps: ["no_os_isolation"], cpu_sec: 20 },
  };
  return {
    config,
    run: async () => ({ ...base, ...result }),
    spawn: async () => {
      throw new Error("W6: no spawn in this test");
    },
  };
}

describe("W6 run_shell foreground cpu marker", () => {
  it("maps SIGXCPU with a CPU cap to cpu_exceeded and names the effective limit", async () => {
    const sandbox = stubSandbox({
      exit_code: null,
      signal: "SIGXCPU",
      sandbox: { provider: "raw", net_isolated: false, tmp_private: false, seccomp: false, enforcement: "partial", promise_gaps: ["no_os_isolation"], cpu_sec: 3 },
    });
    const tool = runShellTool({ sandbox, processes: new ProcessRegistry() });

    const out = (await tool.execute({ command: "burn" })) as Record<string, unknown>;

    expect(out["signal"]).toBe("SIGXCPU");
    expect(out["cpu_exceeded"]).toBe(true);
    expect(String(out["message"])).toContain("CPU time limit 3s exceeded");
  });

  it("does not mark a normal exit (and adds no signal field)", async () => {
    const sandbox = stubSandbox({ exit_code: 0, signal: null });
    const tool = runShellTool({ sandbox, processes: new ProcessRegistry() });

    const out = (await tool.execute({ command: "true" })) as Record<string, unknown>;

    expect(out["cpu_exceeded"]).toBeUndefined();
    expect(out["signal"]).toBeUndefined();
  });
});
