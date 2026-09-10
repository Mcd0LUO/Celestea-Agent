/**
 * `process_control` — poll / stdin / kill a background process
 * (`crates/tools/src/process.rs`).
 *
 * Handles live in the session-scoped registry and survive across turns; a
 * process that exits is removed from the registry automatically. Failures are
 * results (`{ok:false, error}`), not rejections: "unknown handle" is a normal
 * answer to a stale handle, and callers branch on `ok`.
 */

import type { ProcessRegistry } from "../process/registry.js";
import type { Tool, ToolSpec } from "@celestea/core";

import { optionalStringArg, stringArg } from "../args.js";
import { fnTool } from "../fn-tool.js";

export function processControlSpec(): ToolSpec {
  return {
    name: "process_control",
    description:
      "Control a background process started by run_shell(background=true). Handles live in the session-scoped process registry and survive across turns; a process that exits is removed from the registry automatically. action=poll returns {running, stdout_tail(<=4KB), stderr_tail, exit_code?}; action=kill sends SIGTERM, waits a grace period, then SIGKILL and returns {killed:true}; action=stdin writes one line (content + newline) to the process stdin.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Process handle returned by run_shell(background=true)." },
        action: { type: "string", enum: ["poll", "kill", "stdin"], description: "poll | kill | stdin (see tool description)." },
        content: { type: "string", description: "Line to write to the process stdin (action=stdin only)." },
      },
      required: ["handle", "action"],
      additionalProperties: false,
    },
  };
}

export function processControlTool(processes: ProcessRegistry): Tool {
  return fnTool(processControlSpec(), async (args) => {
    const handle = stringArg(args, "handle").trim();
    if (handle === "") return { ok: false, error: "handle required" };
    const action = optionalStringArg(args, "action") ?? "";
    if (action === "poll") return processes.poll(handle);
    if (action === "kill") return processes.kill(handle);
    if (action === "stdin") {
      const content = optionalStringArg(args, "content");
      if (content === undefined) return { ok: false, error: "content required for action=stdin" };
      return processes.stdinLine(handle, content);
    }
    return { ok: false, error: `unknown action: ${action}` };
  });
}
