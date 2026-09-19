/**
 * W885 — the shared gates answer this host truthfully.
 *
 * A gate that is silently always false would skip every guarded suite and look
 * green; a gate that is always true would defeat the skip. Asserting the Linux
 * host's real capabilities catches both mistakes.
 */

import { describe, expect, it } from "vitest";

import { bwrapUsable, fileModesMeaningful, posixOnly, posixProcessGroups, posixScript, posixShell, prlimitUsable } from "./lib/platform-gates.js";

describe("W885 shared platform gates", () => {
  // W891: the gates must answer each host TRUTHFULLY. The POSIX half keeps the
  // original Linux assertions; the Windows half pins the negatives, so neither
  // "always true" nor "always false" can pass on either CI runner.
  it.skipIf(!posixShell)("answers the POSIX host truthfully (Linux: bwrap + prlimit + sh)", () => {
    expect(posixShell).toBe(true);
    expect(posixProcessGroups).toBe(true);
    expect(fileModesMeaningful).toBe(true);
    expect(posixOnly).toBe(true);
    expect(bwrapUsable).toBe(true);
    expect(prlimitUsable).toBe(true);
  });

  it.skipIf(posixShell)("answers a Windows host truthfully (no sh, no mode bits)", () => {
    expect(posixShell).toBe(false);
    expect(posixProcessGroups).toBe(false);
    expect(fileModesMeaningful).toBe(false);
    expect(posixOnly).toBe(false);
    expect(bwrapUsable).toBe(false);
    expect(prlimitUsable).toBe(false);
  });

  it.skipIf(!posixShell)("mints a runnable POSIX script (null would mean skip)", () => {
    expect(posixScript("echo hi")).toBe("#!/bin/sh\necho hi\n");
  });

  it.skipIf(posixShell)("refuses to mint a POSIX script off POSIX", () => {
    expect(posixScript("echo hi")).toBeNull();
  });
});
