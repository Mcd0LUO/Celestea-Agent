/**
 * W9: the permission baseline controls which roots bwrap binds rw.
 */
import { describe, expect, it } from "vitest";
import { buildBwrapArgv, DEFAULT_BWRAP_OPTIONS } from "./bwrap-argv.js";

describe("W9 bwrap rwRoots", () => {
  it("binds the workspace rw by default and omits it for read-only", () => {
    const on = buildBwrapArgv("/ws", DEFAULT_BWRAP_OPTIONS).join(" ");
    expect(on).toContain("--bind /ws /ws");
    const off = buildBwrapArgv("/ws", { ...DEFAULT_BWRAP_OPTIONS, workspaceWritable: false }).join(" ");
    expect(off).not.toContain("--bind /ws /ws");
    expect(off).toContain("--chdir /ws");
    expect(off).toContain("--ro-bind / /");
  });

  it("binds extra permission write roots rw and de-duplicates", () => {
    const s = buildBwrapArgv("/ws", { ...DEFAULT_BWRAP_OPTIONS, writeRoots: ["/repo", "/harness", "/repo"] }).join(" ");
    expect(s).toContain("--bind /ws /ws");
    expect(s).toContain("--bind /repo /repo");
    expect(s).toContain("--bind /harness /harness");
    expect(s.split("--bind /repo /repo").length - 1).toBe(1);
  });
});

describe("W864 allPaths — the whole host root goes rw", () => {
  it("replaces --ro-bind / / with one --bind / / placed before --dev/--proc", () => {
    const argv = buildBwrapArgv("/ws", { ...DEFAULT_BWRAP_OPTIONS, writeRoots: ["/"] });
    const whole = argv.filter((part, i) => part === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/");
    expect(whole).toHaveLength(1);
    expect(argv).not.toContain("--ro-bind");
    // The W274 invariant survives: the rw host root goes on FIRST, the private
    // devtmpfs/procfs on top of it (measured live in the W864 report: a trailing
    // --bind / / lets /dev/zero answer EACCES).
    expect(argv.indexOf("--bind")).toBeLessThan(argv.indexOf("--dev"));
    expect(argv.indexOf("--dev")).toBeLessThan(argv.indexOf("--proc"));
    expect(argv).toContain("--chdir");
  });

  it("leaves every non-'/' configuration byte-identical (still --ro-bind / /)", () => {
    const argv = buildBwrapArgv("/ws", DEFAULT_BWRAP_OPTIONS);
    expect(argv.slice(2, 5)).toEqual(["--ro-bind", "/", "/"]);
    expect(argv.join(" ")).not.toContain("--bind / /");
    const extra = buildBwrapArgv("/ws", { ...DEFAULT_BWRAP_OPTIONS, writeRoots: ["/repo"] });
    expect(extra).toContain("--ro-bind");
    expect(extra.join(" ")).toContain("--bind /repo /repo");
  });
});

