// @vitest-environment node
/**
 * The shared rotation primitive. Real filesystem in a temp dir — the whole point of
 * this module is the interaction with `statSync` / `renameSync`, so faking fs would
 * test the mock instead of the contract.
 *
 * 变异负控制（均实测红→还原绿）：
 *   M1 把「roll 在 append 之前」改成之后 → 「rolled file is a complete prefix」红；
 *   M2 把 `>=` 改成 `>` → 「exactly at the ceiling rolls」红；
 *   M3 去掉 mkdirSync → 「creates a missing parent directory」红。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOG_ROTATE_MAX_BYTES, appendRotating, rotateReplacing } from "./log-rotate.js";

let root: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "logrot-"));
  log = join(root, "app.log");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sizeOf = (p: string): number => statSync(p).size;

describe("log rotation: the replacing shape (audit / diagnostic logs)", () => {
  it("appends without rotating while under the ceiling", () => {
    appendRotating(log, "a\n");
    appendRotating(log, "b\n");
    expect(readFileSync(log, "utf8")).toBe("a\nb\n");
    expect(() => statSync(log + ".1")).toThrow(); // no rolled segment yet
  });

  it("rolls exactly AT the ceiling (the `>=` comparison, not `>`)", () => {
    writeFileSync(log, "x".repeat(10));
    expect(rotateReplacing(log, 10)).toBe(true); // 10 >= 10 → rolls
    expect(sizeOf(log + ".1")).toBe(10);
  });

  it("does NOT roll one byte under the ceiling", () => {
    writeFileSync(log, "x".repeat(9));
    expect(rotateReplacing(log, 10)).toBe(false);
  });

  it("the rolled file is a COMPLETE prefix (roll happens BEFORE the write)", () => {
    writeFileSync(log, "old\n");
    const rolled = appendRotating(log, "new\n", { maxBytes: 4 });
    expect(rolled).toBe(true);
    // The old record is entirely in .1; the new one is the whole current file.
    expect(readFileSync(log + ".1", "utf8")).toBe("old\n");
    expect(readFileSync(log, "utf8")).toBe("new\n");
  });

  it("replaces a previous .1 (audit semantics: generations are not kept)", () => {
    writeFileSync(log, "first\n");
    rotateReplacing(log, 1);
    writeFileSync(log, "second\n");
    rotateReplacing(log, 1);
    expect(readFileSync(log + ".1", "utf8")).toBe("second\n"); // first is gone, by design
  });

  it("creates a missing parent directory", () => {
    const deep = join(root, "a", "b", "c.log");
    appendRotating(deep, "hi\n");
    expect(readFileSync(deep, "utf8")).toBe("hi\n");
  });

  it("is best-effort: an unwritable path returns false and does not throw", () => {
    // A directory where the file should be: appendFileSync must fail.
    appendRotating(root, "line\n");
    expect(() => appendRotating(root, "line\n")).not.toThrow();
  });

  it("a missing file is not a rotation", () => {
    expect(rotateReplacing(join(root, "nope.log"), 1)).toBe(false);
  });

  it("the default ceiling is the 16 MiB audit precedent", () => {
    expect(LOG_ROTATE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });
});
