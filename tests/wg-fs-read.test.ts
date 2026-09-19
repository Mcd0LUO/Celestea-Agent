/**
 * G5 follow-up — `GET /api/fs/read` (the file manager's viewer).
 *
 * Frozen wire format: 200 { path, size, kind, text, offset, limit, totalLines,
 * truncated }; 4xx { error, code? }. The semantics are the `read_file` tool's
 * (binary sniff, 256 KiB budget, line pagination), and the trust discipline is
 * `fs/list`'s (absolute only, directory is an error, symlinks never followed).
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getJson, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

interface ReadBody {
  path: string;
  size: number;
  kind: "text" | "binary";
  text: string;
  offset: number;
  limit: number;
  totalLines: number;
  truncated: boolean;
}

function read(h: StudioHarness, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, `/api/fs/read?${query}`);
}

describe("G5 follow-up · /api/fs/read", () => {
  it("reads a text file whole (kind=text, size, totalLines, no truncation)", async () => {
    const h = makeHarness();
    const file = join(h.root, "note.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    const body = res.body as unknown as ReadBody;
    expect(body.path).toBe(file);
    expect(body.kind).toBe("text");
    expect(body.text).toBe("alpha\nbeta\ngamma\n");
    expect(body.size).toBe(17);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(2000);
    expect(body.totalLines).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it("pages by 1-based offset and limit, and says truncated when more remains", async () => {
    const h = makeHarness();
    const file = join(h.root, "five.txt");
    writeFileSync(file, "1\n2\n3\n4\n5\n");
    const res = await read(h, `path=${encodeURIComponent(file)}&offset=2&limit=2`);
    const body = res.body as unknown as ReadBody;
    expect(res.status).toBe(200);
    expect(body.text).toBe("2\n3\n");
    expect(body.offset).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.totalLines).toBe(5);
    expect(body.truncated).toBe(true);
  });

  it("marks an offset past EOF as empty + not truncated (totalLines still exact)", async () => {
    const h = makeHarness();
    const file = join(h.root, "five.txt");
    writeFileSync(file, "1\n2\n3\n4\n5\n");
    const res = await read(h, `path=${encodeURIComponent(file)}&offset=999`);
    const body = res.body as unknown as ReadBody;
    expect(res.status).toBe(200);
    expect(body.text).toBe("");
    expect(body.totalLines).toBe(5);
    expect(body.truncated).toBe(false);
  });

  it("classifies a NUL-bearing file as binary and returns NO text", async () => {
    const h = makeHarness();
    const file = join(h.root, "blob.bin");
    writeFileSync(file, Buffer.from([0x41, 0x00, 0x42, 0x43]));
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    const body = res.body as unknown as ReadBody;
    expect(res.status).toBe(200);
    expect(body.kind).toBe("binary");
    expect(body.text).toBe("");
    expect(body.totalLines).toBe(0);
    expect(body.size).toBe(4);
  });

  it("classifies a C0-control byte (not \t\n\r\f ESC) as binary", async () => {
    const h = makeHarness();
    const file = join(h.root, "bell.bin");
    writeFileSync(file, Buffer.from([0x07, 0x68, 0x69]));
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    expect((res.body as unknown as ReadBody).kind).toBe("binary");
  });

  it("classifies invalid UTF-8 as binary", async () => {
    const h = makeHarness();
    const file = join(h.root, "bad-utf8.bin");
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    expect((res.body as unknown as ReadBody).kind).toBe("binary");
  });

  it("flags an over-budget file truncated:true instead of silently cutting", async () => {
    const h = makeHarness();
    const file = join(h.root, "big.txt");
    writeFileSync(file, "x\n".repeat(200_000)); // ~400 KB > 256 KiB
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    const body = res.body as unknown as ReadBody;
    expect(res.status).toBe(200);
    expect(body.kind).toBe("text");
    expect(body.truncated).toBe(true);
    expect(body.totalLines).toBe(200_000);
    expect(Buffer.byteLength(body.text, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("400s a directory (never lists it)", async () => {
    const h = makeHarness();
    mkdirSync(join(h.root, "adir"));
    const res = await read(h, `path=${encodeURIComponent(join(h.root, "adir"))}`);
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("is a directory");
    expect(res.body["code"]).toBe("is_directory");
  });

  it("400s a missing path and a relative path with distinct codes", async () => {
    const h = makeHarness();
    const missing = await read(h, `path=${encodeURIComponent(join(h.root, "nope.txt"))}`);
    expect(missing.status).toBe(400);
    expect(missing.body["code"]).toBe("not_found");
    const relative = await read(h, "path=relative%2Ffile.txt");
    expect(relative.status).toBe(400);
    expect(String(relative.body["error"])).toContain("must be absolute");
    expect(relative.body["code"]).toBe("not_absolute");
  });

  it("refuses to follow a symbolic link (same discipline as fs/list)", async (ctx) => {
    const h = makeHarness();
    const target = join(h.root, "real.txt");
    writeFileSync(target, "secret\n");
    const link = join(h.root, "link.txt");
    // W891: creating a symlink needs SeCreateSymbolicLinkPrivilege on Windows
    // (an unelevated process gets EPERM), so this is a VISIBLE skip there.
    // On Linux the original assertion below is untouched.
    try {
      symlinkSync(target, link);
    } catch (error) {
      ctx.skip(`symlinks are not permitted on this host (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
      return;
    }
    const res = await read(h, `path=${encodeURIComponent(link)}`);
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("symlink");
    expect(String(res.body["error"])).toContain("symbolic link");
  });

  it("400s a non-positive offset/limit", async () => {
    const h = makeHarness();
    const file = join(h.root, "x.txt");
    writeFileSync(file, "x\n");
    expect((await read(h, `path=${encodeURIComponent(file)}&offset=0`)).body["code"]).toBe("invalid_offset");
    expect((await read(h, `path=${encodeURIComponent(file)}&limit=abc`)).body["code"]).toBe("invalid_limit");
  });

  it("400s a missing path query", async () => {
    const h = makeHarness();
    const res = await read(h, "offset=1");
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("missing_path");
  });
});
