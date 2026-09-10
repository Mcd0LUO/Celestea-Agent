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
      "Run a shell command inside the sandbox (v2 OS isolation when available: namespaces + read-only root + resource limits, else the v1 userspace path; fixed workdir, sanitized env, bounded timeout and output) and return stdout, stderr, exit code, and a `sandbox` object {provider: bwrap|raw|userspace, net_isolated, tmp_private, seccomp} reporting the effective isolation (W249: network isolated and /tmp a private tmpfs by default; CELESTEA_SANDBOX_NET=1 / CELESTEA_SANDBOX_SHARE_TMP=1 restore the shared host net/tmp; CELESTEA_SANDBOX_SECCOMP=1 enables the seccomp whitelist). With background:true the command is spawned detached (no call-level timeout; resource limits still apply) and returns {background, handle, pid} immediately — control it with the process_control tool (poll / stdin / kill); background processes live in the session process registry and survive across turns. Default timeout is 30s; raise it with timeout_ms up to the cap configured by CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000ms).",
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
        background: {
          type: "boolean",
          description:
            "Optional, default false. When true, spawn the command detached (no call-level timeout; rlimits still apply) and return {background:true, handle, pid} immediately; control the process with process_control (poll / stdin / kill). On natural exit the system pushes a completion message into the session mailbox (notify:false turns that off).",
        },
        notify: {
          type: "boolean",
          description:
            "Optional, default true. When background:true and the process exits naturally, the system posts a '[process] <handle> exited code=<n>' completion message (with stdout/stderr tails) to the session mailbox so the agent is re-engaged automatically; set false to suppress that message (poll via process_control instead).",
        },
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
    if (boolArg(args, "background", false)) {
      const spawned = await options.sandbox.spawn({ command, workdir });
      const handle = options.processes.insert(spawned.child, boolArg(args, "notify", true));
      return { background: true, handle: handle.handle, pid: handle.pid, sandbox: spawned.sandbox };
    }
    const run = await options.sandbox.run({ command, workdir, timeoutMs: optionalIntArg(args, "timeout_ms") });
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exit_code: run.exit_code,
      stdout_truncated: run.stdout_truncated,
      stderr_truncated: run.stderr_truncated,
      sandbox: run.sandbox,
    };
  });
}
