/**
 * `GET /api/fs/read` (iteration G follow-up) — read ONE file for the file
 * manager's viewer. Before this endpoint the Win-style manager could list a
 * directory but not OPEN a file (F2's preview P0 only rendered content the
 * session already had).
 *
 * Frozen wire format (`docs/iteration-g-workbench.md` §0.1 follow-up):
 *   200: { path, size, kind: "text"|"binary", text, offset, limit, totalLines, truncated }
 *   4xx: { error, code? }
 *
 * Semantics are the `read_file` TOOL's, not a second rulebook:
 *   - read-only; `path` must be absolute;
 *   - a directory is an error (EISDIR), never a listing;
 *   - binary detection shares the tool's sniff window (`BINARY_SNIFF_BYTES`):
 *     a NUL/C0 control (except \t \n \r \f ESC) or a fatal UTF-8 decode means
 *     `kind: "binary"` and NO body text;
 *   - the byte budget is `MAX_READ_BYTES` (256 KiB) and pagination is
 *     `offset` (1-based line) + `limit` (lines, default `DEFAULT_READ_LIMIT`);
 *     an over-budget / beyond-window read sets `truncated: true` EXPLICITLY.
 *
 * Trust boundary: this endpoint shares `GET /api/fs/list`'s exactly — it is
 * read-only, it never follows a symbolic link (the same discipline the listing
 * applies to entries), and it has NO auth of its own: the server binds loopback
 * by default, and a non-loopback bind is refused unless a token is configured
 * (see `auth/api-token.ts`). It must never be widened without that gate.
 */

import { lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { BINARY_SNIFF_BYTES, DEFAULT_READ_LIMIT, isToolFailure, readTextLines } from "@celestea/tools";
import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { isAbsolutePath } from "../store/session-id.js";
import { errText } from "../store/result.js";
import type { Deps } from "./common.js";

/** The frozen 200 body. */
export interface FsReadBody {
  path: string;
  size: number;
  kind: "text" | "binary";
  /** The requested window; "" for a binary file (never decoded). */
  text: string;
  /** 1-based first line of the returned window. */
  offset: number;
  /** Effective line budget. */
  limit: number;
  /** Lines in the file (0 for a binary file). */
  totalLines: number;
  /** true when the response is a WINDOW (more lines and/or the 256 KiB budget). */
  truncated: boolean;
}

type ReadOutcome = { ok: true; body: FsReadBody } | { ok: false; error: string; code: string };

/** NUL, or a C0 control other than \t (09) \n (0a) \r (0d) \f (0c) ESC (1b). */
export function hasBinaryControl(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) return true;
  }
  return false;
}

/** true when the window is not valid UTF-8 (fatal decode throws). */
export function isFatalUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** The shared `read_file` rule: control bytes or invalid UTF-8 ⇒ binary. */
export function classifyBytes(bytes: Buffer): "text" | "binary" {
  if (hasBinaryControl(bytes)) return "binary";
  return isFatalUtf8(bytes) ? "binary" : "text";
}

/** Sniff the first `BINARY_SNIFF_BYTES` bytes (the tool's own window). */
async function sniffKind(path: string, size: number): Promise<"text" | "binary"> {
  if (size === 0) return "text";
  const handle = await open(path, "r");
  try {
    const length = Math.min(size, BINARY_SNIFF_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return classifyBytes(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Validate one positive-integer query param. */
function positiveInt(raw: string | undefined, fallback: number, name: string): { value: number } | { error: string; code: string } {
  if (raw === undefined || raw.trim() === "") return { value: fallback };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
    return { error: `query '${name}' must be a positive integer (got ${JSON.stringify(raw)})`, code: `invalid_${name}` };
  }
  return { value: parsed };
}

function lstatOutcome(path: string): { size: number } | { error: string; code: string } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") return { error: `path '${path}' does not exist`, code: "not_found" };
    return { error: `cannot read '${path}': ${errText(e)}`, code: "io_error" };
  }
  // Same discipline as the listing: a link is reported, never traversed.
  if (stat.isSymbolicLink()) return { error: `path '${path}' is a symbolic link; links are not followed`, code: "symlink" };
  if (stat.isDirectory()) return { error: `path '${path}' is a directory, not a file`, code: "is_directory" };
  return { size: stat.size };
}

/** Read one file for the API (exported for the unit tests). */
export async function readFileForApi(path: string, offset: number, limit: number): Promise<ReadOutcome> {
  if (!isAbsolutePath(path)) return { ok: false, error: `path '${path}' must be absolute`, code: "not_absolute" };
  const meta = lstatOutcome(path);
  if ("error" in meta) return { ok: false, error: meta.error, code: meta.code };
  const binaryBody = (kind: "binary"): FsReadBody => ({ path, size: meta.size, kind, text: "", offset, limit, totalLines: 0, truncated: false });
  let kind: "text" | "binary";
  try {
    kind = await sniffKind(path, meta.size);
  } catch (e) {
    return { ok: false, error: `cannot read '${path}': ${errText(e)}`, code: "io_error" };
  }
  if (kind === "binary") return { ok: true, body: binaryBody("binary") };
  try {
    const window = await readTextLines(path, offset - 1, limit);
    return {
      ok: true,
      body: {
        path,
        size: meta.size,
        kind: "text",
        text: window.text,
        offset: window.offset + 1,
        limit: window.limit,
        totalLines: window.totalLines,
        truncated: window.truncated || window.hasMore,
      },
    };
  } catch (e) {
    // A NUL beyond the sniff window: the tool says binary; classify the same way.
    if (isToolFailure(e) && e.kind === "binary_file") return { ok: true, body: binaryBody("binary") };
    return { ok: false, error: `cannot read '${path}': ${errText(e)}`, code: "io_error" };
  }
}

export function registerFsRead(app: Hono, _deps: Deps, table: RouteTable): string {
  const route = table.get("get_fs_read");
  app.on(route.method, route.honoPath, async (c) => {
    const path = (c.req.query("path") ?? "").trim();
    if (path === "") return c.json({ error: "query 'path' is required", code: "missing_path" }, 400);
    const offset = positiveInt(c.req.query("offset"), 1, "offset");
    if ("error" in offset) return c.json({ error: offset.error, code: offset.code }, 400);
    const limit = positiveInt(c.req.query("limit"), DEFAULT_READ_LIMIT, "limit");
    if ("error" in limit) return c.json({ error: limit.error, code: limit.code }, 400);
    const out = await readFileForApi(path, offset.value, limit.value);
    if (!out.ok) return c.json({ error: out.error, code: out.code }, 400);
    return c.json(out.body);
  });
  return route.id;
}
