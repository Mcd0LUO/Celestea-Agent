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
