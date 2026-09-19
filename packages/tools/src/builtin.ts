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
 * user-question service. It is NOT one of the six builtins, and it is
 * OPTIONAL: `packages/tools` may only depend on `@celestea/core`, so the service
 * arrives by construction and an embedding that has no human answerer simply
 * leaves `questions` out instead of registering a tool that can never work.
 */

import type { Sandbox, Tool, UserQuestionService } from "@celestea/core";

import { askUserTool } from "./tools/ask-user.js";
import { httpRequestTool, type HttpRequestToolOptions } from "./tools/http-request.js";
import { listDirTool } from "./tools/list-dir.js";
import { processControlTool } from "./tools/process-control.js";
import { loadSkillTool } from "./tools/load-skill.js";
import { readImageTool } from "./tools/read-image.js";
import { readFileTool } from "./tools/read-file.js";
import { browserActTool, browserOpenTool } from "./tools/browser.js";
import { BrowserManager } from "./browser/session.js";
import type { AttachmentStore } from "./attachments/store.js";
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
  /**
   * W804: the session's attachment store. Present = `read_image` is mounted
   * (12 tools); absent = the tool is not offered, so the model is never told it
   * exists (the same "register only what works" rule as ask_user_question).
   */
  attachments?: AttachmentStore | null;
  /**
   * W804: false ONLY when the target model's input_modalities was explicitly
   * configured without "image" (section 6.6). Absent/true = optimistic default.
   */
  imageInputAllowed?: boolean;
  /** W804: the model id, for the read_image refusal text. */
  model?: string;
  /**
   * W884: the composing SESSION's workspace root for `load_skill` (W768's
   * `sessionWorkspaceOf` — the single source of truth). `null`/absent = a
   * generation with no workspace (the detached default); the tool is still
   * REGISTERED so every face advertises the same names, and a call fails with a
   * structured `no_workspace` error instead of guessing a path.
   */
  workspace?: string | null;
  /** W884: environment the CELESTEA_HOME global skill layer resolves under. */
  env?: NodeJS.ProcessEnv;
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
    // W884: the 7th builtin — always mounted so the model face cannot drift
    // between the detached default generation and a real session.
    loadSkillTool({
      workspace: options.workspace ?? null,
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
  ];
  // W783: only when a human answerer actually exists in this host.
  if (options.questions !== undefined && options.questions !== null) tools.push(askUserTool({ questions: options.questions }));
  // W804: only when the session has an attachment store to read from / write to.
  if (options.attachments !== undefined && options.attachments !== null) {
    tools.push(
      readImageTool({
        attachments: options.attachments,
        imageInputAllowed: options.imageInputAllowed ?? true,
        ...(options.model === undefined ? {} : { model: options.model }),
      }),
    );
    // F4 step 2b: the browser tools need the SAME session attachment store
    // (the screenshot rides the existing image chain) and share ONE manager, so
    // browser_open and browser_act drive the same page and process.
    const manager = new BrowserManager({ sandbox, processes, attachments: options.attachments });
    tools.push(browserOpenTool({ manager }), browserActTool({ manager }));
  }
  return tools;
}
