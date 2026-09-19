/**
 * G5 — `GET /api/fs/list` (the Win-style file manager's directory+file listing).
 *
 * Frozen wire format (docs/iteration-g-workbench.md §0.1): entries carry
 * `{name, type: "dir"|"file", size, mtime}`. This suite pins the discipline it
 * shares with `browse` (absolute path, dot-names hidden, symlinks NOT followed,
 * sorted) plus its own additions (`truncated`, directories first).
 */

import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_DIR_ENTRIES } from "../apps/studio/src/config.js";
import { getJson, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

function make(): StudioHarness {
  return makeHarness();
}

interface ListEntry {
  name: string;
  type: "dir" | "file";
  size: number | null;
  mtime: string | null;
}

describe("G5 · /api/fs/list", () => {
  it("lists directories AND files with type/size/mtime, dirs first then names", async () => {
    const h = make();
    mkdirSync(join(h.root, "zdir"));
    writeFileSync(join(h.root, "a.txt"), "hello");
    writeFileSync(join(h.root, "b.txt"), "hi");
    const res = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(h.root)}`);
    expect(res.status).toBe(200);
    expect(res.body["path"]).toBe(h.root);
    expect(res.body["truncated"]).toBe(false);
    const entries = res.body["entries"] as ListEntry[];
    const names = entries.map((e) => e.name);
    // Directories first (dist/sample-ws/zdir), then files by name; the data
    // files the harness planted in the same root sort with the files.
    expect(names).toEqual(["dist", "sample-ws", "zdir", "a.txt", "b.txt", "recovery-audit.jsonl", "workspaces.json"]);
    const a = entries.find((e) => e.name === "a.txt") as ListEntry;
    expect(a.type).toBe("file");
    expect(a.size).toBe(5);
    expect(a.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const dist = entries.find((e) => e.name === "dist") as ListEntry;
    expect(dist.type).toBe("dir");
    expect(dist.size).toBeNull();
  });

  it("hides dot-names (same policy as browse)", async () => {
    const h = make();
    mkdirSync(join(h.root, ".hidden"));
    writeFileSync(join(h.root, ".secret"), "x");
    const res = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(h.root)}`);
    const names = (res.body["entries"] as ListEntry[]).map((e) => e.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".secret");
  });

  it("reports a symlink as a file and never follows it to a directory", async (ctx) => {
    const h = make();
    mkdirSync(join(h.root, "real-dir"));
    // W891: symlink creation is EPERM for an unelevated Windows process; skip
    // visibly there and keep the Linux assertion byte-identical.
    try {
      symlinkSync(join(h.root, "real-dir"), join(h.root, "link-to-dir"));
    } catch (error) {
      ctx.skip(`symlinks are not permitted on this host (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
      return;
    }
    const res = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(h.root)}`);
    const link = (res.body["entries"] as ListEntry[]).find((e) => e.name === "link-to-dir") as ListEntry;
    expect(link.type).toBe("file");
    expect(link.mtime).toBe(new Date(lstatSync(join(h.root, "link-to-dir")).mtimeMs).toISOString());
  });

  it("400s the frozen error shape for a relative path and a missing directory", async () => {
    const h = make();
    const relative = await getJson(h.app, "/api/fs/list?path=relative");
    expect(relative.status).toBe(400);
    expect(relative.body).toMatchObject({ path: "relative", parent: null, entries: [], truncated: false });
    expect(String(relative.body["error"])).toContain("must be absolute");

    const missing = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(join(h.root, "nope"))}`);
    expect(missing.status).toBe(400);
    expect(String(missing.body["error"])).toContain("is not an existing directory");
  });

  it("400s a path that is a FILE, not a directory", async () => {
    const h = make();
    const file = join(h.root, "a.txt");
    writeFileSync(file, "x");
    const res = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("is not an existing directory");
  });

  it("caps at MAX_DIR_ENTRIES and says so (truncated=true)", async () => {
    const h = make();
    for (let i = 0; i < MAX_DIR_ENTRIES + 5; i += 1) writeFileSync(join(h.root, `f${String(i).padStart(4, "0")}.txt`), "x");
    const res = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(h.root)}`);
    expect(res.status).toBe(200);
    expect(res.body["truncated"]).toBe(true);
    expect((res.body["entries"] as ListEntry[]).length).toBe(MAX_DIR_ENTRIES);
  });

  it("does not cap (truncated=false) when the count fits", async () => {
    const h = make();
    writeFileSync(join(h.root, "only.txt"), "x");
    const res = await getJson(h.app, `/api/fs/list?path=${encodeURIComponent(h.root)}`);
    expect(res.body["truncated"]).toBe(false);
    expect((res.body["entries"] as ListEntry[]).length).toBeLessThan(MAX_DIR_ENTRIES);
  });
});
