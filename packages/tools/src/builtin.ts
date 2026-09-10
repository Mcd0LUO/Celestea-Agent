/**
 * The six builtin tools (`crates/tools/src/builtin.rs`): `read_file`,
 * `write_file`, `list_dir`, `run_shell`, `process_control`, `http_request`.
 *
 * One `ProcessRegistry` and one `Sandbox` are shared by `run_shell` /
 * `process_control` within a tool set, so a background process started in one
 * call is controllable from the next. Embeddings that mount several tool sets
 * pass `builtinTools({ processes, sandbox })` a shared pair.
 */

import type { Sandbox, Tool } from "@celestea/core";

import { httpRequestTool, type HttpRequestToolOptions } from "./tools/http-request.js";
import { listDirTool } from "./tools/list-dir.js";
import { processControlTool } from "./tools/process-control.js";
import { readFileTool } from "./tools/read-file.js";
import { runShellTool } from "./tools/run-shell.js";
import { writeFileTool } from "./tools/write-file.js";
import { ProcessRegistry } from "./process/registry.js";
import { userspaceSandbox } from "./sandbox/userspace.js";

export interface BuiltinToolsOptions {
  sandbox?: Sandbox;
  processes?: ProcessRegistry;
  http?: HttpRequestToolOptions;
}

/** The six builtins, sharing one sandbox + one process registry. */
export function builtinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const processes = options.processes ?? new ProcessRegistry();
  const sandbox = options.sandbox ?? userspaceSandbox();
  return [
    readFileTool(),
    writeFileTool(),
    listDirTool(),
    runShellTool({ sandbox, processes }),
    processControlTool(processes),
    httpRequestTool(options.http ?? {}),
  ];
}
