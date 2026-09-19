/**
 * W885 — executable lookup and interpreter resolution.
 *
 * The PATH rules are the ones W883 B13 called out: a Windows `PATH` is
 * `;`-separated and its entries contain drive letters, so splitting on `:`
 * produced nonsense. `whichInPath` takes the platform as an argument and an
 * injectable existence check, so both dialects are proven here on Linux.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { POSIX_SHELL } from "../testing/platform-gates.js";
import { whichInPath } from "./exec.js";

const BS = "\\";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A POSIX temp dir that really exists (for the real-filesystem cases). */
function realDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w885-lookup-"));
  roots.push(dir);
  return dir;
}

describe("W885 whichInPath · POSIX", () => {
  it("splits PATH on ':' and returns the first hit", () => {
    const found = whichInPath("ls", "linux", { PATH: "/nope:/usr/bin:/bin" }, (path) => path === "/bin/ls");
    expect(found).toBe("/bin/ls");
  });

  it("keeps the historical /usr/bin:/bin floor when PATH is unset", () => {
    expect(whichInPath("sh", "linux", {}, (path) => path === "/bin/sh")).toBe("/bin/sh");
  });

  it("treats a slash-bearing name as a path and does not suffix it", () => {
    expect(whichInPath("bin/tool", "linux", { PATH: "/usr/bin" }, (path) => path === "bin/tool")).toBe("bin/tool");
    expect(whichInPath("bin/tool", "linux", { PATH: "/usr/bin" }, () => false)).toBeNull();
  });

  it("finds a real executable on a real PATH (no injection)", (ctx) => {
    // W891: the real-filesystem half needs an executable bit and a POSIX ":" PATH;
    // it is gated (POSIX_SHELL is false on Windows) so the pure cases above still
    // pin the rules there. This host runs the original assertion.
    if (!POSIX_SHELL) {
      ctx.skip("a real executable lookup needs a POSIX host (mode bits + ':' PATH)");
      return;
    }
    const dir = realDir();
    writeFileSync(join(dir, "w885-tool"), "#!/bin/sh\n", { mode: 0o755 });
    expect(whichInPath("w885-tool", "linux", { PATH: `${dir}:/usr/bin` })).toBe(join(dir, "w885-tool"));
  });
});

describe("W885 whichInPath · Windows", () => {
  it("splits on ';' and never on the drive letters' colons (W883 B13)", () => {
    const search = `C:${BS}Windows${BS}System32;D:${BS}tools`;
    const found = whichInPath("bash.exe", "win32", { PATH: search }, (path) => path === `D:${BS}tools${BS}bash.exe`);
    expect(found).toBe(`D:${BS}tools${BS}bash.exe`);
  });

  it("tries PATHEXT suffixes after the exact name", () => {
    const dir = `C:${BS}bin`;
    const found = whichInPath("foo", "win32", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT" }, (path) => path === `${dir}${BS}foo.exe`);
    expect(found).toBe(`${dir}${BS}foo.exe`);
  });

  it("prefers the exact name when it exists", () => {
    const dir = `C:${BS}bin`;
    const found = whichInPath("foo", "win32", { PATH: dir }, (path) => path === `${dir}${BS}foo` || path === `${dir}${BS}foo.exe`);
    expect(found).toBe(`${dir}${BS}foo`);
  });

  it("falls back to the built-in suffix list when PATHEXT is unset", () => {
    const dir = `C:${BS}bin`;
    expect(whichInPath("bar", "win32", { PATH: dir }, (path) => path === `${dir}${BS}bar.cmd`)).toBe(`${dir}${BS}bar.cmd`);
  });

  it("looks for an absolute candidate directly", () => {
    const absolute = `C:${BS}Program Files${BS}Git${BS}bin${BS}bash.exe`;
    expect(whichInPath(absolute, "win32", {}, (path) => path === absolute)).toBe(absolute);
  });
});
