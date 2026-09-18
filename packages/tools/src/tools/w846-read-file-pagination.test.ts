/**
 * W846 — `read_file` offset/limit pagination.
 *
 * Hard contract: a default (no offset/limit) read is byte-for-byte the legacy
 * `readTextFile` result; a paged read returns a line window whose pagination
 * metadata rides on `value` (render is not projected to the model).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_READ_LIMIT, MAX_READ_BYTES, readTextLines } from "../fs/file-io.js";
import { createToolRegistry } from "../registry.js";
import { readFileSpec, readFileTool } from "./read-file.js";

function withTmpDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "w846-read-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function write(dir: string, name: string, content: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

async function dispatch(args: Record<string, unknown>) {
  const registry = createToolRegistry([readFileTool()]);
  return registry.dispatch({ call_id: "c1", name: "read_file", args });
}

interface PagedValue {
  text: string;
  offset: number;
  limit: number;
  lineCount: number;
  totalLines: number;
  hasMore: boolean;
  nextOffset: number | null;
  truncated: boolean;
  totalBytes: number;
}

describe("W846 · read_file offset/limit spec", () => {
  it("declares integer offset (>=0) and limit (>=1), keeping path required", () => {
    const params = readFileSpec().parameters as unknown as Record<string, unknown>;
    const props = params["properties"] as Record<string, { type?: string; minimum?: number }>;
    expect(props["offset"]?.type).toBe("integer");
    expect(props["offset"]?.minimum).toBe(0);
    expect(props["limit"]?.type).toBe("integer");
    expect(props["limit"]?.minimum).toBe(1);
    expect(params["required"]).toEqual(["path"]);
    expect(params["additionalProperties"]).toBe(false);
  });
});

describe("W846 · default read is byte-for-byte the legacy value", () => {
  it("returns the raw text (no notice) for a small file", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "a.txt", "hello\nworld\n");
      const out = await dispatch({ path: p });
      expect(out.error).toBeNull();
      expect(out.value).toBe("hello\nworld\n");
      expect(out.render).toBeNull();
    });
  });

  it("truncates at MAX_READ_BYTES with the same value bytes and a render note", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "big.txt", "a".repeat(MAX_READ_BYTES + 500));
      const out = await dispatch({ path: p });
      expect(out.error).toBeNull();
      expect(out.value).toBe("a".repeat(MAX_READ_BYTES));
      expect(typeof out.render).toBe("string");
      expect(String(out.render)).toContain("[truncated]");
    });
  });
});

describe("W846 · paged read", () => {
  it("returns a window with exact line semantics and metadata on value", async () => {
    await withTmpDir(async (dir) => {
      const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
      const p = write(dir, "ten.txt", lines.map((l) => l + "\n").join(""));
      const out = await dispatch({ path: p, offset: 2, limit: 3 });
      expect(out.error).toBeNull();
      const v = out.value as PagedValue;
      expect(v.text).toBe("L2\nL3\nL4\n");
      expect(v.offset).toBe(2);
      expect(v.limit).toBe(3);
      expect(v.lineCount).toBe(3);
      expect(v.totalLines).toBe(10);
      expect(v.hasMore).toBe(true);
      expect(v.nextOffset).toBe(5);
      expect(v.truncated).toBe(false);
      expect(v.totalBytes).toBe(30);
    });
  });

  it("defaults offset to 0 and limit to DEFAULT_READ_LIMIT", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "few.txt", "a\nb\nc\n");
      const limitOnly = (await dispatch({ path: p, limit: 2 })).value as PagedValue;
      expect(limitOnly.offset).toBe(0);
      expect(limitOnly.limit).toBe(2);
      expect(limitOnly.text).toBe("a\nb\n");
      expect(limitOnly.nextOffset).toBe(2);
      const offsetOnly = (await dispatch({ path: p, offset: 1 })).value as PagedValue;
      expect(offsetOnly.offset).toBe(1);
      expect(offsetOnly.limit).toBe(DEFAULT_READ_LIMIT);
      expect(offsetOnly.text).toBe("b\nc\n");
      expect(offsetOnly.hasMore).toBe(false);
    });
  });

  it("returns an empty window past EOF without erroring", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "few.txt", "a\nb\n");
      for (const offset of [2, 99]) {
        const out = await dispatch({ path: p, offset });
        expect(out.error).toBeNull();
        const v = out.value as PagedValue;
        expect(v.text).toBe("");
        expect(v.lineCount).toBe(0);
        expect(v.hasMore).toBe(false);
        expect(v.nextOffset).toBeNull();
      }
    });
  });

  it("rejects negative/zero/non-integer pagination args before running", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "few.txt", "a\n");
      for (const args of [{ offset: -1 }, { limit: 0 }, { offset: 1.5 }, { limit: "3" }]) {
        const out = await dispatch({ path: p, ...args });
        expect(out.value).toBeNull();
        expect(out.error ?? "").toMatch(/offset|limit/);
      }
    });
  });

  it("flips truncated when the byte budget clips the window", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "longline.txt", "x".repeat(MAX_READ_BYTES + 10) + "\ntail\n");
      const v = (await dispatch({ path: p, offset: 0, limit: 10 })).value as PagedValue;
      expect(v.truncated).toBe(true);
      expect(v.text.length).toBeLessThanOrEqual(MAX_READ_BYTES);
      expect(v.lineCount).toBe(1);
      expect(v.hasMore).toBe(true);
      expect(v.nextOffset).toBe(1);
    });
  });

  it("reconstructs the whole file by following nextOffset", async () => {
    await withTmpDir(async (dir) => {
      const content = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n") + "\n";
      const p = write(dir, "many.txt", content);
      let offset = 0;
      let acc = "";
      let pages = 0;
      for (;;) {
        const v = (await dispatch({ path: p, offset, limit: 4 })).value as PagedValue;
        acc += v.text;
        pages += 1;
        if (!v.hasMore) break;
        offset = v.nextOffset as number;
        if (pages > 20) throw new Error("pagination did not terminate");
      }
      expect(acc).toBe(content);
      expect(pages).toBe(7);
    });
  });

  it("preserves CRLF and a missing trailing newline byte-for-byte", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "crlf.txt", "a\r\nb\r\nc");
      const v = (await dispatch({ path: p, offset: 0, limit: 10 })).value as PagedValue;
      expect(v.text).toBe("a\r\nb\r\nc");
      expect(v.totalLines).toBe(3);
    });
  });

  it("still rejects a binary file on the paged path", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "bin", Buffer.from([0x61, 0x00, 0x62, 0x0a]));
      const out = await dispatch({ path: p, offset: 0, limit: 1 });
      expect(out.value).toBeNull();
      expect(out.error ?? "").toMatch(/binary/i);
    });
  });
});

describe("W846 · readTextLines unit", () => {
  it("counts an unterminated final line and reports hasMore/nextOffset", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "u.txt", "one\ntwo\nthree");
      const v = await readTextLines(p, 1, 1);
      expect(v.text).toBe("two\n");
      expect(v.totalLines).toBe(3);
      expect(v.hasMore).toBe(true);
      expect(v.nextOffset).toBe(2);
      const tail = await readTextLines(p, 2, 5);
      expect(tail.text).toBe("three");
      expect(tail.hasMore).toBe(false);
      expect(tail.nextOffset).toBeNull();
    });
  });

  it("treats an empty file as zero lines", async () => {
    await withTmpDir(async (dir) => {
      const p = write(dir, "empty.txt", "");
      const v = await readTextLines(p, 0, 10);
      expect(v.text).toBe("");
      expect(v.totalLines).toBe(0);
      expect(v.hasMore).toBe(false);
      expect(v.truncated).toBe(false);
    });
  });
});
