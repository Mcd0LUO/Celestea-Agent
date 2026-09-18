/**
 * `read_file` — read a UTF-8 text file and return its contents as a string
 * (legacy `builtin.rs::read_file_spec`). A default (no `offset`/`limit`) read
 * keeps the canonical value shape: the value stays the text, the truncation
 * travels in the authored `render`. Passing `offset`/`limit` (W846) returns a
 * line window whose pagination metadata lives on `value` — `render` is not
 * projected to the model, so metadata there would be invisible.
 */

import type { Tool, ToolExecOutcome, ToolSpec } from "@celestea/core";

import { optionalIntArg, stringArg } from "../args.js";
import { descParam } from "../desc.js";
import { DEFAULT_READ_LIMIT, MAX_READ_BYTES, readTextFile, readTextLines, truncationNote } from "../fs/file-io.js";

export function readFileSpec(): ToolSpec {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file and return its contents as a string. A whole read is capped at 256 KiB; pass offset (0-based line) and/or limit (line count) to page through a larger file — a paged result is an object {text, offset, limit, lineCount, totalLines, hasMore, nextOffset, truncated, totalBytes}.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Filesystem path of the file to read." },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Optional 0-based line index to start from (pagination). Omit to read from the top.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of lines to return (pagination). Omit to use the default window.",
        },
        desc: descParam(),
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

/** W855 (B6): `surface` carries the truncation note into the model face. */
type ReadOutcome = ToolExecOutcome;

async function read(args: unknown): Promise<ReadOutcome> {
  const path = stringArg(args, "path");
  const offset = optionalIntArg(args, "offset");
  const limit = optionalIntArg(args, "limit");
  // No pagination params: the legacy byte read, value byte-for-byte unchanged.
  if (offset === undefined && limit === undefined) {
    const result = await readTextFile(path);
    if (!result.truncated) return { value: result.text, render: null };
    const note = truncationNote(
      `'${path}'`,
      MAX_READ_BYTES,
      result.totalBytes,
      "bytes",
      'read the rest with offset/limit, or run_shell on the same path (head -c / tail -c / sed -n)',
    );
    // W855 (B6): the note must reach the MODEL too — `render` is display-only
    // (never projected), so it rides as a surface descriptor on the log row.
    return { value: result.text, render: note, surface: { kind: "truncation", note } };
  }
  // W846 pagination: line window; metadata on `value` (render is not projected).
  const window = await readTextLines(path, offset ?? 0, limit ?? DEFAULT_READ_LIMIT);
  const lastLine = window.offset + window.lineCount - 1;
  const more = window.hasMore
    ? `; ${window.totalLines - window.offset - window.lineCount} more at offset=${window.nextOffset}`
    : "";
  return {
    value: {
      text: window.text,
      offset: window.offset,
      limit: window.limit,
      lineCount: window.lineCount,
      totalLines: window.totalLines,
      hasMore: window.hasMore,
      nextOffset: window.nextOffset,
      truncated: window.truncated,
      totalBytes: window.totalBytes,
    },
    render:
      window.hasMore || window.truncated
        ? `read_file: lines ${window.offset}-${lastLine} of ${window.totalLines}${more}${window.truncated ? " (window clipped at 256 KiB)" : ""}`
        : null,
  };
}

export function readFileTool(): Tool {
  const spec = readFileSpec();
  return {
    spec: () => spec,
    execute: async (args) => (await read(args)).value,
    executeWith: async (input) => read(input.args),
  };
}
