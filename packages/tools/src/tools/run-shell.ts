/**
 * `run_shell` — **orchestration only** (`crates/tools/src/builtin.rs`).
 *
 * This tool never spawns anything itself: it validates arguments, delegates
 * execution to the injected `Sandbox` seam, and — for `background: true` —
 * hands the detached child to the session process registry so
 * `process_control` can drive it across turns. Consequences:
 * - swapping in the P2c OS-isolated sandbox changes no line here;
 * - a timeout/kill/workdir failure arrives as a structured `SandboxError`
 *   (`run_shell-sandbox: code=…`), never as prose;
 * - the effective isolation mode is reported back inside `sandbox`.
 */

import type { Sandbox, Tool, ToolSpec } from "@celestea/core";

import { boolArg, optionalIntArg, optionalStringArg, stringArg } from "../args.js";
import { descParam } from "../desc.js";
import { fnTool } from "../fn-tool.js";
import type { ProcessRegistry } from "../process/registry.js";

export interface RunShellToolOptions {
  /** The execution boundary (userspace-lite in P2b, OS-isolated in P2c). */
  sandbox: Sandbox;
  /** Session-scoped registry that owns background children. */
  processes: ProcessRegistry;
}

export function runShellSpec(): ToolSpec {
  return {
    name: "run_shell",
    description:
      "Run a shell command inside the sandbox (v2 OS isolation when available: namespaces + read-only root + resource limits, else the v1 userspace path; fixed workdir, sanitized env, bounded timeout and output) and return stdout, stderr, exit code, and a `sandbox` object {provider: bwrap|raw|userspace, net_isolated, tmp_private, seccomp} reporting the effective isolation (W249: network isolated and /tmp a private tmpfs by default; CELESTEA_SANDBOX_NET=1 / CELESTEA_SANDBOX_SHARE_TMP=1 restore the shared host net/tmp; CELESTEA_SANDBOX_SECCOMP=1 enables the seccomp whitelist). With background:true the command is spawned detached (no call-level timeout; resource limits still apply) and returns {background, handle, pid} immediately — control it with the process_control tool (poll / stdin / kill); background processes live in the session process registry and survive across turns. Default timeout is 30s; raise it with timeout_ms up to the cap configured by CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000ms). Optional cpu_sec overrides RLIMIT_CPU for THIS process (default 20s, foreground and background alike); values above the cap from CELESTEA_SHELL_MAX_CPU_SEC (default 600) are CLAMPED to it, and a CPU-cap kill is reported as cpu_exceeded.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute." },
        workdir: {
          type: "string",
          description:
            "Optional working directory. Must already exist inside the sandbox root; relative paths resolve against the sandbox workdir.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-call timeout in milliseconds. Default 30000; can be raised up to the cap from CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000). Ignored when background:true.",
        },
        cpu_sec: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-call CPU time limit in seconds (RLIMIT_CPU) for THIS process, foreground or background. Default 20; values above CELESTEA_SHELL_MAX_CPU_SEC (default 600) are clamped to that cap. A process killed by the CPU limit reports cpu_exceeded:true with a message naming the limit.",
        },
        background: {
          type: "boolean",
          description:
            "Optional, default false. When true, spawn the command detached (no call-level timeout; rlimits including cpu_sec still apply) and return {background:true, handle, pid} immediately; control the process with process_control (poll / stdin / kill). A process that exits stays pollable from a bounded tombstone (most recent 32, or 10 minutes), so poll after exit still returns exit_code/signal and the tails.",
        },
        notify: {
          type: "boolean",
          description:
            "Optional, default true. When background:true, whether a NATURAL exit may be offered to a host completion sink. No sink is wired in this deployment, so read the terminal state with process_control(action=poll); the flag is kept for hosts that install one.",
        },
        desc: descParam(),
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

export function runShellTool(options: RunShellToolOptions): Tool {
  return fnTool(runShellSpec(), async (args) => {
    const command = stringArg(args, "command");
    const workdir = optionalStringArg(args, "workdir");
    const cpuSec = optionalIntArg(args, "cpu_sec");
    const cpu = cpuSec === undefined ? {} : { cpuSec };
    if (boolArg(args, "background", false)) {
      const spawned = await options.sandbox.spawn({ command, workdir, ...cpu });
      const handle = options.processes.insert(spawned.child, boolArg(args, "notify", true), {
        cpuSec: spawned.sandbox.cpu_sec ?? cpuSec ?? null,
      });
      return { background: true, handle: handle.handle, pid: handle.pid, sandbox: spawned.sandbox };
    }
    const run = await options.sandbox.run({ command, workdir, timeoutMs: optionalIntArg(args, "timeout_ms"), ...cpu });
    // W6: an RLIMIT_CPU kill (SIGXCPU, or the SIGKILL that follows) must not read
    // as a bare death; mark it when the provider reported a CPU cap in force.
    const cpuExceeded =
      run.exit_code === null && run.sandbox.cpu_sec !== undefined && (run.signal === "SIGXCPU" || run.signal === "SIGKILL");
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exit_code: run.exit_code,
      ...(run.signal === null || run.signal === undefined ? {} : { signal: run.signal }),
      ...(cpuExceeded ? { cpu_exceeded: true, message: `CPU time limit ${run.sandbox.cpu_sec}s exceeded` } : {}),
      stdout_truncated: run.stdout_truncated,
      stderr_truncated: run.stderr_truncated,
      sandbox: run.sandbox,
    };
  });
}
