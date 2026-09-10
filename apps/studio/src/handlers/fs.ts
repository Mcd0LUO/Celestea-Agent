/**
 * `GET /api/fs/browse` — `src/workspaces.rs:700-766`.
 *
 * Read-only directory listing: absolute existing directory, DIRECTORY names
 * only (files are never listed), dot-names hidden, symlinks not followed
 * (`withFileTypes` reports the link itself), sorted, capped at 200. `roots` is
 * a hardcoded informational constant — browsing is NOT restricted to it; the
 * endpoint has no auth, which is why the default bind is loopback.
 */

import { readdirSync } from "node:fs";
import type { Hono } from "hono";
import { FS_ROOTS, MAX_DIR_ENTRIES } from "../config.js";
import type { RouteTable } from "../routes.js";
import { errText } from "../store/result.js";
import type { Deps } from "./common.js";

interface BrowseBody {
  path: string;
  parent: string | null;
  dirs: string[];
  roots: readonly string[];
  error?: string;
}

function browseDirs(path: string): { dirs: string[] } | { error: string } {
  if (!path.startsWith("/")) return { error: `path '${path}' must be absolute` };
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { error: `path '${path}' is not an existing directory` };
    return { error: `cannot read '${path}': ${errText(e)}` };
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    dirs.push(e.name);
  }
  dirs.sort();
  return { dirs: dirs.slice(0, MAX_DIR_ENTRIES) };
}

function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at <= 0 ? "/" : trimmed.slice(0, at);
}

export function registerFs(app: Hono, _deps: Deps, table: RouteTable): string[] {
  const browse = table.get("get_fs_browse");
  app.on(browse.method, browse.honoPath, (c) => {
    const asked = (c.req.query("path") ?? "").trim();
    const raw = asked === "" ? "/" : asked;
    const out = browseDirs(raw);
    if ("error" in out) {
      const body: BrowseBody = { path: raw, parent: null, dirs: [], roots: FS_ROOTS, error: out.error };
      return c.json(body, 400);
    }
    const body: BrowseBody = { path: raw, parent: parentOf(raw), dirs: out.dirs, roots: FS_ROOTS };
    return c.json(body);
  });
  return [browse.id];
}
