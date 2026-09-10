/**
 * `write_file` — create or overwrite a text file, answering `"ok"` like Rust
 * (`builtin.rs::write_file`). The path policy (workspace-only writes) is
 * enforced by the guard chain, not here.
 */

import type { Tool, ToolSpec } from "@celestea/core";

import { stringArg } from "../args.js";
import { writeTextFile } from "../fs/file-io.js";
import { fnTool } from "../fn-tool.js";

export function writeFileSpec(): ToolSpec {
  return {
    name: "write_file",
    description: "Write text content to a file, creating or overwriting it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Filesystem path of the file to write." },
        content: { type: "string", description: "Text content to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };
}

export function writeFileTool(): Tool {
  return fnTool(writeFileSpec(), async (args) => {
    await writeTextFile(stringArg(args, "path"), stringArg(args, "content"));
    return "ok";
  });
}
