/**
 * W885 — the Windows tree-kill BRANCH SELECTION (not the kill itself).
 *
 * `taskkill /PID <pid> /T /F` is the only tree-kill Windows ships, and it is
 * inherently racy (a child may re-parent between the walk and the kill), so this
 * slice treats it as best effort and leaves the real fix (Job Objects) to W885
 * slice 2. What IS testable on a Linux host is the decision: the POSIX path must
 * never shell out, and the Windows branch must decline rather than throw when
 * taskkill cannot run (there is no taskkill here, which is exactly the fallback
 * case `signalTree` relies on).
 *
 * NOT verified on this host: that taskkill actually reaps a real Windows tree.
 */

import { describe, expect, it } from "vitest";

import { taskkillTree } from "./child.js";

describe("W885 taskkillTree", () => {
  it("declines on POSIX — the group signal stays the only POSIX mechanism", () => {
    expect(taskkillTree(1, "linux")).toBe(false);
    expect(taskkillTree(1, "darwin")).toBe(false);
  });

  it("returns false (never throws) when taskkill is unavailable", () => {
    expect(taskkillTree(999_999, "win32")).toBe(false);
  });
});
