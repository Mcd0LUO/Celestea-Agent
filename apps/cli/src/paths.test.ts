import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliPaths, firstRunGuidance } from "./paths.js";

describe("cliPaths (celestea-home data root)", () => {
  it("roots every file at $CELESTEA_HOME", () => {
    // W891: `home` is injected verbatim, but the files under it are joined with
    // the host separator — assert via join() so Windows matches too.
    const home = "/data/celestea";
    const paths = cliPaths({ CELESTEA_HOME: home }, home);
    expect(paths.home).toBe(home);
    expect(paths.workspacesFile).toBe(join(home, "workspaces.json"));
    expect(paths.providersFile).toBe(join(home, "providers.json"));
    expect(paths.promptsFile).toBe(join(home, "prompts.json"));
  });
  it("derives a Windows root from USERPROFILE (injected platform)", () => {
    const paths = cliPaths({ USERPROFILE: "C:\\Users\\dev" }, "C:\\Users\\dev\\.celestea");
    expect(paths.home).toBe("C:\\Users\\dev\\.celestea");
  });
  it("gives actionable first-run guidance only when the key is missing", () => {
    const paths = cliPaths({ CELESTEA_HOME: "/d" }, "/d");
    expect(firstRunGuidance(paths, true)).toEqual([]);
    const lines = firstRunGuidance(paths, false);
    expect(lines.join("\n")).toContain(join("/d", "providers.json"));
    expect(lines.join("\n")).toContain("CELESTEA_API_KEY");
  });
});
