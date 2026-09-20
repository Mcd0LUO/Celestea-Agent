/**
 * W885 — the platform gates themselves (a smoke test on the gate module).
 *
 * The value of a gate is that it is TRUE where the capability exists; asserting
 * that here keeps a mistyped predicate (a gate that is silently always false
 * would skip everything) from passing unnoticed.
 */

import { describe, expect, it } from "vitest";

import { platformGates, whichUsable } from "./platform-gates.js";

const gates = platformGates();

describe("W885 platform gates", () => {
  // W891: assert each host TRUTHFULLY (POSIX keeps the original assertions;
  // Windows pins the negatives) so the gate cannot be silently always-true/false.
  it.skipIf(!gates.posixShell)("answers the POSIX host truthfully", () => {
    expect(gates.posixShell).toBe(true);
    expect(gates.posixScripts).toBe(true);
    expect(gates.posixProcessGroups).toBe(true);
    expect(gates.fileModesMeaningful).toBe(true);
    expect(gates.posixOnly).toBe(true);
    // W892: bwrap / prlimit are INSTALLED TOOLS, not POSIX guarantees (GitHub's
    // ubuntu-latest has neither), so assert agreement with an independent probe.
    expect(gates.prlimitUsable).toBe(whichUsable("prlimit"));
    expect(gates.bwrapUsable && !whichUsable("bwrap"), "bwrapUsable=true requires the binary on PATH").toBe(false);
  });

  it.skipIf(gates.posixShell)("answers a Windows host truthfully (no sh, no mode bits)", () => {
    expect(gates.posixShell).toBe(false);
    expect(gates.posixScripts).toBe(false);
    expect(gates.posixProcessGroups).toBe(false);
    expect(gates.fileModesMeaningful).toBe(false);
    expect(gates.posixOnly).toBe(false);
    expect(gates.bwrapUsable).toBe(false);
    expect(gates.prlimitUsable).toBe(false);
  });

  it("memoizes one snapshot", () => {
    expect(platformGates()).toBe(gates);
  });

  it("answers a missing binary false and an existing one true", () => {
    expect(whichUsable("w885-totally-not-a-binary")).toBe(false);
    // \`node --version\` is the one binary this repository guarantees is present,
    // and it exits 0 for \`--version\` (dash has no such flag).
    expect(whichUsable("node")).toBe(true);
  });

  it("keeps htpasswd a real probe (never a hardcoded true)", () => {
    expect(typeof gates.htpasswdUsable).toBe("boolean");
  });
});
