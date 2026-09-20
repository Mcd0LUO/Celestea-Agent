/**
 * W880 — the CELESTEA_HOME resolution order, one assertion per rung.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { celesteaHome, workspaceHome, workspaceSubdir } from "./celestea-home.js";

describe("W880 · celesteaHome resolution order", () => {
  it("1) $CELESTEA_HOME wins over everything (Linux and Windows)", () => {
    expect(
      celesteaHome({ env: { CELESTEA_HOME: "/var/lib/celestea-agent", XDG_DATA_HOME: "/xdg", USERPROFILE: "C:\\Users\\a" }, platform: "linux", homedir: "/home/a" }),
    ).toBe("/var/lib/celestea-agent");
    expect(celesteaHome({ env: { CELESTEA_HOME: "/data", XDG_DATA_HOME: "/xdg" }, platform: "win32", homedir: "C:\\Users\\a" })).toBe("/data");
  });

  it("2) Linux: $XDG_DATA_HOME/celestea", () => {
    expect(celesteaHome({ env: { XDG_DATA_HOME: "/xdg" }, platform: "linux", homedir: "/home/a" })).toBe("/xdg/celestea");
  });

  it("3) Linux/macOS default: ~/.celestea (macOS ignores XDG)", () => {
    expect(celesteaHome({ env: {}, platform: "linux", homedir: "/home/a" })).toBe("/home/a/.celestea");
    expect(celesteaHome({ env: {}, platform: "darwin", homedir: "/Users/a" })).toBe("/Users/a/.celestea");
    expect(celesteaHome({ env: { XDG_DATA_HOME: "/xdg" }, platform: "darwin", homedir: "/Users/a" })).toBe("/Users/a/.celestea");
  });

  it("4) Windows default: %USERPROFILE%\\.celestea (homedir fallback)", () => {
    expect(celesteaHome({ env: { USERPROFILE: "C:\\Users\\a" }, platform: "win32", homedir: "C:\\ignored" })).toBe("C:\\Users\\a\\.celestea");
    expect(celesteaHome({ env: {}, platform: "win32", homedir: "C:\\Users\\a" })).toBe("C:\\Users\\a\\.celestea");
  });

  it("ignores blank overrides", () => {
    expect(celesteaHome({ env: { CELESTEA_HOME: "   ", XDG_DATA_HOME: "  " }, platform: "linux", homedir: "/home/a" })).toBe("/home/a/.celestea");
  });
});

describe("W880 · workspaceHome / workspaceSubdir", () => {
  it("keys by the workspace folder name, like workspaces.json", () => {
    const input = { env: { CELESTEA_HOME: "/data" } };
    // W892: the product joins with the HOST separator, so the expectation must too.
    expect(workspaceHome("/src/foo", input)).toBe(join("/data", "workspaces", "foo"));
    expect(workspaceHome("/src/foo/", input)).toBe(join("/data", "workspaces", "foo"));
    expect(workspaceSubdir("/src/foo", "sessions", input)).toBe(join("/data", "workspaces", "foo", "sessions"));
  });
});

