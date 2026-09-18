/**
 * W855 (B6)/C7: the default read_file truncation note must reach the MODEL, not
 * only the display-only render. It rides a structured surface descriptor, which
 * the registry carries on the ToolOutput.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_READ_BYTES } from "../fs/file-io.js";
import { createToolRegistry } from "../registry.js";
import { readFileTool } from "./read-file.js";

describe("W855 B6 read_file truncation surface", () => {
  it("carries the truncation note as a surface, not only as render", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w855-read-"));
    const file = join(dir, "big.txt");
    writeFileSync(file, "x".repeat(MAX_READ_BYTES + 100));
    const registry = createToolRegistry([readFileTool()]);

    const out = await registry.dispatch({ call_id: "c1", name: "read_file", args: { path: file } });

    expect(out.error).toBeNull();
    expect(typeof out.value).toBe("string");
    expect(Buffer.byteLength(out.value as string, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(out.surface).toMatchObject({ kind: "truncation" });
    const note = out.surface?.kind === "truncation" ? out.surface.note : "";
    expect(note).toContain("[truncated]");
    expect(out.render).toBe(note);
  });

  it("does not surface an untruncated read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w855-read-"));
    const file = join(dir, "small.txt");
    writeFileSync(file, "hello");
    const registry = createToolRegistry([readFileTool()]);

    const out = await registry.dispatch({ call_id: "c1", name: "read_file", args: { path: file } });

    expect(out.value).toBe("hello");
    expect(out.surface).toBeUndefined();
  });
});
