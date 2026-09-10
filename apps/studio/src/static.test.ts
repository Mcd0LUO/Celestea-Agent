import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serveStaticPath, contentTypeFor, sanitizeRel } from "./static.js";

const root = mkdtempSync(join(tmpdir(), "studio-static-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>studio</title>");
writeFileSync(join(root, "assets", "app.js"), "export const x = 1;");
mkdirSync(join(root, "..", "outside"), { recursive: true });
writeFileSync(join(root, "..", "outside", "leak.txt"), "LEAK");
symlinkSync(join(root, "..", "outside"), join(root, "link-out"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(root, "..", "outside"), { recursive: true, force: true });
});

describe("static serving", () => {
  it("serves the SPA index for /", async () => {
    const res = serveStaticPath(root, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("studio");
  });

  it("serves a build asset with its content type", async () => {
    const res = serveStaticPath(root, "/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("export const x");
  });

  it("falls back to index.html for an extensionless SPA route", async () => {
    const res = serveStaticPath(root, "/sessions/sample-ws/abc");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("404s a missing asset with an extension", async () => {
    const res = serveStaticPath(root, "/assets/missing.js");
    expect(res.status).toBe(404);
  });

  it("refuses path traversal and never reads outside the root", async () => {
    expect(sanitizeRel("../outside/leak.txt")).toBeNull();
    expect(serveStaticPath(root, "/../outside/leak.txt").status).toBe(404);
    expect(serveStaticPath(root, "/%2e%2e/outside/leak.txt").status).toBe(404);
    expect(serveStaticPath(root, "/assets/../../outside/leak.txt").status).toBe(404);
  });

  it("refuses a symlink that escapes the root", async () => {
    const res = serveStaticPath(root, "/link-out/leak.txt");
    expect(res.status).toBe(404);
  });

  it("answers /api/* with the JSON 404 (never the SPA)", async () => {
    const res = serveStaticPath(root, "/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("serves the build hint page when dist is absent", async () => {
    const res = serveStaticPath(join(root, "no-such-dist"), "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("build the frontend first");
  });

  it("maps extensions to content types", () => {
    expect(contentTypeFor("a.css")).toContain("text/css");
    expect(contentTypeFor("a.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
  });
});
