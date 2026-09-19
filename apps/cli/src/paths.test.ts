import { describe, expect, it } from "vitest";
import { cliPaths, firstRunGuidance } from "./paths.js";

describe("cliPaths (celestea-home data root)", () => {
  it("roots every file at $CELESTEA_HOME", () => {
    const paths = cliPaths({ CELESTEA_HOME: "/data/celestea" }, "/data/celestea");
    expect(paths.home).toBe("/data/celestea");
    expect(paths.workspacesFile).toBe("/data/celestea/workspaces.json");
    expect(paths.providersFile).toBe("/data/celestea/providers.json");
    expect(paths.promptsFile).toBe("/data/celestea/prompts.json");
  });
  it("derives a Windows root from USERPROFILE (injected platform)", () => {
    const paths = cliPaths({ USERPROFILE: "C:\\Users\\dev" }, "C:\\Users\\dev\\.celestea");
    expect(paths.home).toBe("C:\\Users\\dev\\.celestea");
  });
  it("gives actionable first-run guidance only when the key is missing", () => {
    const paths = cliPaths({ CELESTEA_HOME: "/d" }, "/d");
    expect(firstRunGuidance(paths, true)).toEqual([]);
    const lines = firstRunGuidance(paths, false);
    expect(lines.join("\n")).toContain("/d/providers.json");
    expect(lines.join("\n")).toContain("CELESTEA_API_KEY");
  });
});
