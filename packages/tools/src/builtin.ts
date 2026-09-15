/**
 * The six builtin tools (`crates/tools/src/builtin.rs`): `read_file`,
 * `write_file`, `list_dir`, `run_shell`, `process_control`, `http_request`.
 *
 * One `ProcessRegistry` and one `Sandbox` are shared by `run_shell` /
 * `process_control` within a tool set, so a background process started in one
 * call is controllable from the next. Embeddings that mount several tool sets
 * pass `builtinTools({ processes, sandbox })` a shared pair.
 *
 * W783: `ask_user_question` is mounted here too when the caller supplies the
 * user-question service. It is NOT one of the six Rust builtins, and it is
 * OPTIONAL: `packages/tools` may only depend on `@celestea/core`, so the service
 * arrives by construction and an embedding that has no human answerer simply
 * leaves `questions` out instead of registering a tool that can never work.
 */

import type { Sandbox, Tool, UserQuestionService } from "@celestea/core";

import { askUserTool } from "./tools/ask-user.js";
import { httpRequestTool, type HttpRequestToolOptions } from "./tools/http-request.js";
import { listDirTool } from "./tools/list-dir.js";
import { processControlTool } from "./tools/process-control.js";
import { readFileTool } from "./tools/read-file.js";
import { runShellTool } from "./tools/run-shell.js";
import { writeFileTool } from "./tools/write-file.js";
import { ProcessRegistry } from "./process/registry.js";
import { selectSandbox } from "./sandbox/provider.js";

export interface BuiltinToolsOptions {
  sandbox?: Sandbox;
  processes?: ProcessRegistry;
  http?: HttpRequestToolOptions;
  /**
   * W783: the host's user-question service. Present = `ask_user_question` is
   * registered (11 tools); absent = it is not (the frozen 10).
   */
  questions?: UserQuestionService | null;
}

/** The six builtins, sharing one sandbox + one process registry. */
export function builtinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const processes = options.processes ?? new ProcessRegistry();
  const sandbox = options.sandbox ?? selectSandbox();
  const tools: Tool[] = [
    readFileTool(),
    writeFileTool(),
    listDirTool(),
    runShellTool({ sandbox, processes }),
    processControlTool(processes),
    httpRequestTool(options.http ?? {}),
  ];
  // W783: only when a human answerer actually exists in this host.
  if (options.questions !== undefined && options.questions !== null) tools.push(askUserTool({ questions: options.questions }));
  return tools;
}
