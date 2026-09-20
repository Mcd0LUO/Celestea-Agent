/**
 * W885 — path normalization under an INJECTED win32 (W883 E1/E2/E3).
 *
 * Every case here runs on this Linux host: the platform is an argument, never
 * `process.platform`, which is exactly the property the slice set out to add.
 * The POSIX expectations pin the pre-W885 bytes so the refactor cannot have
 * changed Linux behaviour.
 */

import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { describe, expect, it } from "vitest";

import { browseParent, isBrowsablePath } from "../handlers/fs.js";
import {
  archiveRoots,
  baseName,
  liveDirCandidates,
  parentDir,
  promptsFileCandidates,
  rootOf,
  sessionsRoot,
  trashRoots,
} from "./session-id.js";

const BS = "\\";
const WIN = { platform: "win32" as const, env: { USERPROFILE: `C:${BS}Users${BS}a` } };
const WIN_WS = `C:${BS}ws`;

describe("W885 win32 · session vocabulary (W883 E1: hardcoded '/')", () => {
  it("joins under CELESTEA_HOME with backslashes", () => {
    expect(sessionsRoot(WIN_WS, WIN)).toBe(`C:${BS}Users${BS}a${BS}.celestea${BS}workspaces${BS}ws${BS}sessions`);
  });

  it("probes canonical -> slice-A -> legacy inside the workspace", () => {
    const home = `C:${BS}Users${BS}a${BS}.celestea${BS}workspaces${BS}ws`;
    expect(liveDirCandidates(WIN_WS, "alpha", WIN)).toEqual([
      `${home}${BS}sessions${BS}alpha`,
      `${WIN_WS}${BS}.celestea${BS}sessions${BS}alpha`,
      `${WIN_WS}${BS}alpha`,
    ]);
  });

  it("archive / trash / prompts candidates are canonical-first and win32-joined", () => {
    const home = `C:${BS}Users${BS}a${BS}.celestea${BS}workspaces${BS}ws`;
    expect(archiveRoots(WIN_WS, WIN)).toEqual([`${home}${BS}archive`, `${WIN_WS}${BS}.celestea${BS}archive`, `${WIN_WS}${BS}.celestea-archived`]);
    expect(trashRoots(WIN_WS, WIN)).toEqual([`${home}${BS}trash`, `${WIN_WS}${BS}.celestea${BS}trash`, `${WIN_WS}${BS}.celestea-trash`]);
    expect(promptsFileCandidates(WIN_WS, WIN)).toEqual([
      `${home}${BS}prompts.json`,
      `${WIN_WS}${BS}.celestea${BS}prompts.json`,
      `${WIN_WS}${BS}.celestea-prompts.json`,
    ]);
  });

  it("still produces the host bytes when no platform is injected", () => {
    // W891: uninjected = the HOST. On Linux the values below are byte-identical
    // to the old POSIX literals; on Windows they follow the host separator, which
    // is exactly what "no platform injected" means.
    const home = process.env["CELESTEA_HOME"] ?? join(process.env["HOME"] ?? homedir(), ".celestea");
    expect(sessionsRoot("/ws")).toBe(join(home, "workspaces", "ws", "sessions"));
    expect(baseName("/a/b/c")).toBe(basename("/a/b/c"));
    expect(parentDir("/a/b/c")).toBe(dirname("/a/b/c"));
    expect(rootOf("/a/b")).toBe(parse("/a/b").root);
  });
});

describe("W885 win32 · basename/parent (W883 E2: lastIndexOf('/'))", () => {
  it("takes the win32 basename instead of the whole backslash path", () => {
    const dir = `C:${BS}Users${BS}a${BS}.celestea${BS}workspaces${BS}ws${BS}sessions${BS}main-1789192174.492000000`;
    expect(baseName(dir, "win32")).toBe("main-1789192174.492000000");
    expect(parentDir(`${dir}`, "win32")).toBe(`C:${BS}Users${BS}a${BS}.celestea${BS}workspaces${BS}ws${BS}sessions`);
  });

  it("reports the drive / UNC roots", () => {
    // W892: uninjected = the HOST. A drive path has a root only where the host
    // is win32; on POSIX it has none.
    expect(rootOf(`C:${BS}Users`)).toBe(process.platform === "win32" ? `C:${BS}` : "");
    expect(rootOf(`C:${BS}Users`, "win32")).toBe(`C:${BS}`);
    expect(rootOf(`${BS}${BS}srv${BS}share${BS}x`, "win32")).toBe(`${BS}${BS}srv${BS}share${BS}`);
  });
});

describe("W885 · /api/fs/browse accepts win32 absolute paths (W883 E3)", () => {
  it("accepts a drive path and a UNC share, and still refuses a relative one", () => {
    expect(isBrowsablePath(WIN_WS, "win32")).toBe(true);
    expect(isBrowsablePath(`${BS}${BS}srv${BS}share`, "win32")).toBe(true);
    expect(isBrowsablePath("relative", "win32")).toBe(false);
    expect(isBrowsablePath("relative", "linux")).toBe(false);
    expect(isBrowsablePath("/usr/local", "linux")).toBe(true);
  });

  it("walks up without ever leaving the root", () => {
    expect(browseParent(`C:${BS}Users${BS}a`, "win32")).toBe(`C:${BS}Users`);
    expect(browseParent(`C:${BS}Users${BS}a${BS}`, "win32")).toBe(`C:${BS}Users`);
    expect(browseParent(`C:${BS}`, "win32")).toBe(`C:${BS}`);
    expect(browseParent(`${BS}${BS}srv${BS}share`, "win32")).toBe(`${BS}${BS}srv${BS}share`);
    expect(browseParent(`${BS}${BS}srv${BS}share${BS}x`, "win32")).toBe(`${BS}${BS}srv${BS}share${BS}`);
    expect(browseParent("/usr/local", "linux")).toBe("/usr");
    expect(browseParent("/", "linux")).toBe("/");
    expect(browseParent("/usr/", "linux")).toBe("/");
  });
});
