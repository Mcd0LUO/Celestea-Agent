/**
 * W885 — `parseToolRoots` under an INJECTED platform (W883 §2.2 LIST_SEPARATOR).
 *
 * A Windows `CELESTEA_TOOL_ROOTS` is `;`-separated and its entries carry drive
 * letters; splitting on `:` (the pre-W885 rule) cut `C:\\src` in half. The
 * comma-spelling stays accepted on both platforms, and the POSIX bytes are
 * pinned so Linux behaviour is unchanged.
 */

import { describe, expect, it } from "vitest";

import { parseToolRoots } from "./path-guard.js";

const BS = "\\";

describe("W885 parseToolRoots · win32 keeps drive letters", () => {
  it("splits on ';' and never on the drive colon", () => {
    const value = `C:${BS}src;D:${BS}tools${BS}bin`;
    expect(parseToolRoots(value, "win32")).toEqual([`C:${BS}src`, `D:${BS}tools${BS}bin`]);
  });

  it("still accepts the comma spelling", () => {
    expect(parseToolRoots(`C:${BS}a,D:${BS}b`, "win32")).toEqual([`C:${BS}a`, `D:${BS}b`]);
  });

  it("trims and drops empty entries", () => {
    expect(parseToolRoots(` ; C:${BS}a ;; `, "win32")).toEqual([`C:${BS}a`]);
    expect(parseToolRoots(",, ,", "win32")).toEqual([]);
    expect(parseToolRoots(undefined, "win32")).toEqual([]);
  });
});

describe("W885 parseToolRoots · POSIX is unchanged (regression)", () => {
  it("splits on ':' exactly as before", () => {
    expect(parseToolRoots("/a,/b ,/c")).toEqual(["/a", "/b", "/c"]);
    expect(parseToolRoots("/src/a:/src/b:/tmp")).toEqual(["/src/a", "/src/b", "/tmp"]);
    expect(parseToolRoots("/src/a:/src/b,/tmp")).toEqual(["/src/a", "/src/b", "/tmp"]);
    expect(parseToolRoots(" :/a::")).toEqual(["/a"]);
  });

  it("defaults to the HOST platform when none is passed", () => {
    expect(parseToolRoots("/a:/b")).toEqual(["/a", "/b"]);
  });
});
