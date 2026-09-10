/**
 * `read_file` — read a UTF-8 text file and return its contents as a string
 * (Rust `builtin.rs::read_file_spec`). Truncated reads and binary rejects are
 * reported without changing the canonical value shape: the value stays the
 * text, the truncation travels in the authored `render`.
 */

import type { Tool, ToolSpec } from "@celestea/core";

import { stringArg } from "../args.js";
import { MAX_READ_BYTES, readTextFile, truncationNote } from "../fs/file-io.js";

export function readFileSpec(): ToolSpec {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file and return its contents as a string.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Filesystem path of the file to read." } },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

async function read(args: unknown): Promise<{ text: string; render: string | null }> {
  const path = stringArg(args, "path");
  const result = await readTextFile(path);
  if (!result.truncated) return { text: result.text, render: null };
  return { text: result.text, render: truncationNote(`'${path}'`, MAX_READ_BYTES, result.totalBytes, "bytes") };
}

export function readFileTool(): Tool {
  const spec = readFileSpec();
  return {
    spec: () => spec,
    execute: async (args) => (await read(args)).text,
    executeWith: async (input) => {
      const { text, render } = await read(input.args);
      return { value: text, render };
    },
  };
}
