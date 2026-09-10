/**
 * `list_dir` — list the entry names of a directory (Rust
 * `builtin.rs::list_dir_spec`). Names are sorted for a deterministic result
 * (Rust inherits `read_dir` order), and a long listing is capped with the
 * truncation note in `render`.
 */

import type { Tool, ToolSpec } from "@celestea/core";

import { stringArg } from "../args.js";
import { listDirNames, MAX_DIR_ENTRIES, truncationNote } from "../fs/file-io.js";

export function listDirSpec(): ToolSpec {
  return {
    name: "list_dir",
    description: "List the entry names in a directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path to list." } },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

async function list(args: unknown): Promise<{ value: string[]; render: string | null }> {
  const path = stringArg(args, "path");
  const result = await listDirNames(path);
  if (!result.truncated) return { value: result.names, render: null };
  return {
    value: result.names,
    render: truncationNote(`'${path}'`, MAX_DIR_ENTRIES, result.total, "entries"),
  };
}

export function listDirTool(): Tool {
  const spec = listDirSpec();
  return {
    spec: () => spec,
    execute: async (args) => (await list(args)).value,
    executeWith: async (input) => {
      const { value, render } = await list(input.args);
      return { value, render };
    },
  };
}
