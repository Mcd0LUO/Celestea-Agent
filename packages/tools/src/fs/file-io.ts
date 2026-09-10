/**
 * File IO for `read_file` / `write_file` / `list_dir`, with the two protections
 * the tool contract promises: **truncation** (a bounded read keeps a huge file
 * from flooding the context) and **binary protection** (a NUL-bearing file is
 * rejected instead of being decoded into mojibake).
 *
 * The guard already arbitrated *where* the path may point; this module only
 * performs the IO and reports structured failures (`<tool>: code=… msg="…"`).
 */

import { open, readdir, writeFile } from "node:fs/promises";

import { contractError } from "../errors.js";
import { ToolFailure } from "../tool-failure.js";

/** Bytes returned by one `read_file` call (beyond this: `truncated`). */
export const MAX_READ_BYTES = 256 * 1024;
/** Entry names returned by one `list_dir` call. */
export const MAX_DIR_ENTRIES = 1000;
/** Window inspected for the binary heuristic. */
export const BINARY_SNIFF_BYTES = 8192;

export interface ReadTextResult {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

export interface ListDirResult {
  names: string[];
  truncated: boolean;
  total: number;
}

/** NUL byte inside the sniff window ⇒ binary (the classic, cheap heuristic). */
export function isProbablyBinary(bytes: Buffer): boolean {
  const window = bytes.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0);
}

export async function readTextFile(path: string): Promise<ReadTextResult> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    throw ioFailure("read_file", "io", describe(e));
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw ioFailure("read_file", "io", `'${path}' is a directory, not a file`);
    const wanted = Math.min(MAX_READ_BYTES + 1, Math.max(stat.size, 1));
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (isProbablyBinary(bytes)) {
      throw ioFailure("read_file", "binary_file", `'${path}' looks binary (NUL byte in the first ${BINARY_SNIFF_BYTES} bytes)`);
    }
    const truncated = bytesRead > MAX_READ_BYTES || stat.size > MAX_READ_BYTES;
    return { text: bytes.subarray(0, MAX_READ_BYTES).toString("utf8"), truncated, totalBytes: stat.size };
  } catch (e) {
    throw e instanceof ToolFailure ? e : ioFailure("read_file", "io", describe(e));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, "utf8");
  } catch (e) {
    throw ioFailure("write_file", "io", describe(e));
  }
}

export async function listDirNames(path: string): Promise<ListDirResult> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (e) {
    throw ioFailure("list_dir", "io", describe(e));
  }
  entries.sort();
  return { names: entries.slice(0, MAX_DIR_ENTRIES), truncated: entries.length > MAX_DIR_ENTRIES, total: entries.length };
}

/** `[truncated] showing first X of Y …` — the authored render note. */
export function truncationNote(what: string, shown: number, total: number, unit: string): string {
  return `[truncated] ${what}: showing first ${shown} of ${total} ${unit}`;
}

function ioFailure(tool: string, code: string, message: string): ToolFailure {
  return new ToolFailure(code, contractError(tool, code, message));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
