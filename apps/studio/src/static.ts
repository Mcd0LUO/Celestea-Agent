/**
 * Static file serving + SPA fallback (`src/main.rs:735-847`).
 *
 * The Vite build under `STUDIO_STATIC_ROOT` is served READ-ONLY and hardened
 * twice: `sanitizeRel` refuses `..`, absolute and prefix components on the
 * request path, and the resolved path is then re-checked to sit inside the
 * root (so a symlink cannot escape either). Unknown `/api/*` paths never reach
 * this handler — they are 404 JSON, which is why the API 404 is registered
 * before the fallback. A missing build serves the "build the frontend first"
 * hint page instead.
 */

import { readFileSync, statSync, realpathSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Hono } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const HINT_PAGE = `<!doctype html><meta charset="utf-8"><title>celestea-studio</title>
<body style="font-family:system-ui;padding:2rem">
<h1>celestea-studio TS</h1>
<p>frontend/dist is missing — build the frontend first (<code>pnpm build</code> in frontend/).</p>
<p>The HTTP API is available at <code>/api/*</code>.</p>
</body>`;

export function contentTypeFor(rel: string): string {
  return MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";
}

/** Allow normal components only: reject `..`, absolute and prefix components. */
export function sanitizeRel(rel: string): string | null {
  const parts: string[] = [];
  for (const raw of rel.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === ".." || raw.includes("\\") || raw.includes("\0")) return null;
    parts.push(raw);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

/** Resolve inside the root or refuse (catches symlink escapes too). */
export function resolveWithinRoot(root: string, rel: string): string | null {
  const target = resolve(root, rel);
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  })();
  const real = (() => {
    try {
      return realpathSync(target);
    } catch {
      return target;
    }
  })();
  if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) return null;
  return target;
}

interface StaticFile {
  body: Uint8Array;
  contentType: string;
}

function readIfFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return path;
  } catch {
    return null;
  }
}

function readStatic(root: string, rel: string): StaticFile | null {
  const file = readIfFile(resolveWithinRoot(root, rel) ?? "");
  if (file === null) return null;
  return { body: readFileSync(file), contentType: contentTypeFor(rel) };
}

function bytesResponse(body: Uint8Array, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType, "cache-control": "no-cache" } });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

/** The static/SPA handler; `/api/*` is answered by the caller's 404 route. */
export function serveStaticPath(root: string, rawPath: string): Response {
  if (rawPath.startsWith("/api/")) return Response.json({ error: "not found" }, { status: 404 });
  const rel = sanitizeRel(rawPath.replace(/^\/+/, "") === "" ? "index.html" : rawPath.replace(/^\/+/, ""));
  if (rel === null) return Response.json({ error: "not found" }, { status: 404 });
  const file = readStatic(root, rel);
  if (file !== null) return bytesResponse(file.body, file.contentType);
  if (rel === "index.html" || !rel.includes(".")) {
    const index = readStatic(root, "index.html");
    return index === null ? htmlResponse(HINT_PAGE) : bytesResponse(index.body, "text/html; charset=utf-8");
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export function registerStatic(app: Hono, root: string): void {
  app.get("*", (c) => serveStaticPath(root, new URL(c.req.url).pathname));
}
