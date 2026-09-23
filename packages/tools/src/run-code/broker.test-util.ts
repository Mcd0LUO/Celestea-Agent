/**
 * Shared harness of the `run_code` broker tests (both language matrices).
 *
 * Every case spawns a REAL interpreter inside the REAL userspace sandbox and
 * drives the real line protocol; the sub-call registry is a real
 * `ToolRegistryImpl` (schema validation + guard chain + execute), so what the
 * tests assert is the production pipeline, not a mock of it.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sandbox, SessionEvent, Tool, ToolRegistry, ToolSpec } from "@celestea/core";

import { fnTool } from "../fn-tool.js";
import { userspaceSandboxWith } from "../sandbox/userspace.js";
import { RegistryHandle, runCodeToolWithHandle } from "../tools/run-code.js";
import type { RunCodeConfig } from "./limits.js";
import { ToolRegistryImpl } from "../registry.js";
import { resolveShellKind } from "../platform/exec.js";
import { quoteWord } from "../platform/quote.js";
import { resolveInterpreter } from "./broker.js";

/**
 * W892: the interpreter as ONE shell word, quoted for the sandbox's own shell.
 * Windows routinely installs Node under `C:\\Program Files\\nodejs\\node.exe`
 * (a space), so an unquoted path would be split by cmd.exe/pwsh before it ran.
 */
function interpreterWord(interpreter: string, sandbox: Sandbox): string {
  return quoteWord(resolveShellKind(sandbox.shell).kind, interpreter);
}

/** W775: let a caller inject the sandbox (e.g. one built with the seccomp whitelist). */
export interface BrokerHarnessOptions {
  /** Build the sandbox for `dir`; default: the no-isolation userspace fallback. */
  sandboxFor?: (dir: string) => Sandbox;
}

export interface BrokerHarness {
  /** The sandbox workdir (also the guard root). */
  dir: string;
  sandbox: Sandbox;
  /** `python3` answered inside the sandbox (the Python matrix's skip switch). */
  pythonReady: boolean;
  /** The TypeScript runtime answered inside the sandbox (the TS matrix's switch). */
  nodeReady: boolean;
  /** Why a matrix is not runnable here (empty when both interpreters answered). */
  skipReasons: string[];
  /** Register `run_code`, then bind its handle to that same registry. */
  mount(
    registry: ToolRegistryImpl,
    options?: { events?: (event: SessionEvent) => void; config?: RunCodeConfig },
  ): Tool;
  run(tool: Tool, callId: string, args: unknown): Promise<unknown> & { value?: unknown };
  /** `run_code_*` files left behind in `<workdir>/.celestea/run-code` (W880). */
  leftoverScripts(): Promise<string[]>;
  echoRegistry(): ToolRegistryImpl;
  shellRegistry(): ToolRegistryImpl;
  cleanup(): Promise<void>;
}

/** A schema covering every argument the broker's sub-calls use. */
export function echoSpec(name: string): ToolSpec {
  return {
    name,
    description: `${name} echo (run_code test double)`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        command: { type: "string" },
        content: { type: "string" },
        workdir: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      additionalProperties: false,
    },
  };
}

/** Echo registry: every whitelisted tool answers `{echo: name, args}`. */
export function echoRegistryOn(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const name of ["read_file", "write_file", "list_dir", "run_shell"]) {
    registry.register(fnTool(echoSpec(name), async (args) => ({ echo: name, args })));
  }
  return registry;
}

/** Shell-shaped registry: `run_shell` answers the run_shell result dict. */
export function shellRegistryOn(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  registry.register(fnTool(echoSpec("read_file"), async (args) => ({ echo: "read_file", args })));
  registry.register(
    fnTool(echoSpec("run_shell"), async () => ({
      stdout: "hi\n",
      stderr: "",
      exit_code: 0,
      stdout_truncated: false,
      stderr_truncated: false,
    })),
  );
  return registry;
}

/** Start the sandbox, probe both interpreters, and hand back the helper set. */
export async function startBrokerHarness(options: BrokerHarnessOptions = {}): Promise<BrokerHarness> {
  const dir = await mkdtemp(join(tmpdir(), "celestea-run-code-"));
  const sandbox =
    options.sandboxFor?.(dir) ??
    userspaceSandboxWith({
      workdir: dir,
      root: dir,
      timeoutMs: 30_000,
      maxTimeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    });
  // W839 (R3 B8 / W818-P1-1): "the interpreter is missing" is a RECORDED skip
  // reason, never a silent pass. The matrices gate on these flags with
  // describe.skipIf / it.skipIf, so vitest reports (and counts) a skipped case
  // instead of the old "if (!ready) return", which counted it as passed. Set
  // CELESTEA_REQUIRE_BROKER_RUNTIME=1 (CI) to make a missing interpreter a
  // collection-time failure instead.
  const skipReasons: string[] = [];
  /**
   * W892: probe the interpreter the PRODUCT will actually use, not a POSIX
   * literal. The old probe ran `/usr/bin/node`, which does not exist on Windows
   * — so a host with a perfectly good Node reported "not ready" and the whole
   * TypeScript matrix skipped (a coverage hole, not a red test). `resolveInterpreter`
   * is the production resolver (PATH first, `process.execPath` fallback), so the
   * probe and the run now agree on which binary is being measured.
   *
   * `quoteWord`/the shell kind are not needed here: these probes are literal
   * commands, and the interpreter path is quoted for the shell the sandbox uses.
   */
  const probePython = async (): Promise<boolean> => {
    const python = resolveInterpreter("python");
    try {
      // `--version`, not `-c 'print(1)'`: the interpreter path is quoted for the
      // sandbox's own shell, and a `-c` SNIPPET would need per-shell quoting of
      // its own (cmd.exe does not honour single quotes at all). `--version` needs
      // no argument quoting, so one code path is correct on every shell.
      const r = await sandbox.run({ command: interpreterWord(python, sandbox) + " --version" });
      if (r.exit_code === 0 && (r.stdout + r.stderr).includes("Python")) return true;
      skipReasons.push(python + " did not answer inside the sandbox");
    } catch (error) {
      skipReasons.push(python + " probe threw: " + String(error));
    }
    return false;
  };
  const probeNode = async (): Promise<boolean> => {
    // W774/W892: the TypeScript path needs the same Node the broker uses,
    // reachable from inside the sandbox (bwrap mounts the host root read-only).
    const node = resolveInterpreter("typescript");
    try {
      const r = await sandbox.run({ command: interpreterWord(node, sandbox) + " --version" });
      if (r.exit_code === 0 && r.stdout.startsWith("v")) return true;
      skipReasons.push(node + " did not answer inside the sandbox");
    } catch (error) {
      skipReasons.push(node + " probe threw: " + String(error));
    }
    return false;
  };
  const pythonReady = await probePython();
  const nodeReady = await probeNode();
  if (skipReasons.length > 0) {
    const line = "[run_code] matrices skipped here: " + skipReasons.join("; ");
    if (process.env["CELESTEA_REQUIRE_BROKER_RUNTIME"] === "1") throw new Error(line);
    console.warn(line);
  }

  return {
    dir,
    sandbox,
    pythonReady,
    nodeReady,
    skipReasons,
    mount(
      registry: ToolRegistryImpl,
      options: { events?: (event: SessionEvent) => void; config?: RunCodeConfig } = {},
    ): Tool {
      const { tool, handle } = runCodeToolWithHandle({
        sandbox,
        ...(options.events === undefined ? {} : { events: options.events }),
        ...(options.config === undefined ? {} : { config: options.config }),
      });
      registry.register(tool);
      handle.set(registry);
      return tool;
    },
    async run(tool: Tool, callId: string, args: unknown) {
      if (tool.executeWith === undefined) throw new Error("run_code must override executeWith");
      return tool.executeWith({ call_id: callId, name: "run_code", args });
    },
    async leftoverScripts(): Promise<string[]> {
      const entries = await readdir(join(dir, ".celestea", "run-code")).catch(() => [] as string[]);
      return entries.filter((name) => name.startsWith("run_code_"));
    },
    echoRegistry: echoRegistryOn,
    shellRegistry: shellRegistryOn,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  } satisfies BrokerHarness & { run: (tool: Tool, callId: string, args: unknown) => Promise<unknown> };
}

/** A handle nothing ever bound (the fail-closed wiring case). */
export { RegistryHandle };
