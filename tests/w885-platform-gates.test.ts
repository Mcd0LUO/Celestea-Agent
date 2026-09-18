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
  it("answers the Linux host truthfully (this host: bwrap + prlimit + sh)", () => {
    expect(posixShell).toBe(true);
    expect(posixProcessGroups).toBe(true);
    expect(fileModesMeaningful).toBe(true);
    expect(posixOnly).toBe(true);
    expect(bwrapUsable).toBe(true);
    expect(prlimitUsable).toBe(true);
  });

  it("mints a runnable POSIX script (null would mean skip)", () => {
    expect(posixScript("echo hi")).toBe("#!/bin/sh\necho hi\n");
  });
});
