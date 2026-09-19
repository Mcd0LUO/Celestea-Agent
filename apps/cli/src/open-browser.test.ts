import { describe, expect, it, vi } from "vitest";
import { openBrowser, openerFor } from "./open-browser.js";

describe("openBrowser (cross-platform, injected)", () => {
  it("uses xdg-open on Linux", () => {
    expect(openerFor("http://127.0.0.1:3777/", "linux")).toEqual({ command: "xdg-open", args: ["http://127.0.0.1:3777/"] });
  });
  it("uses cmd /c start on Windows (empty title arg keeps a quoted URL a URL)", () => {
    expect(openerFor("http://127.0.0.1:3777/", "win32")).toEqual({ command: "cmd", args: ["/d", "/s", "/c", "start", "", "http://127.0.0.1:3777/"] });
  });
  it("uses open on macOS", () => {
    expect(openerFor("http://127.0.0.1:3777/", "darwin")).toEqual({ command: "open", args: ["http://127.0.0.1:3777/"] });
  });
  it("launches the platform opener through the injected spawn", () => {
    const spawn = vi.fn();
    const result = openBrowser("http://x/", { platform: "win32", which: () => "C:\\Windows\\System32\\cmd.exe", spawn });
    expect(result.opened).toBe(true);
    expect(spawn).toHaveBeenCalledWith("cmd", ["/d", "/s", "/c", "start", "", "http://x/"], true);
  });
  it("reports a missing opener instead of throwing (headless Linux)", () => {
    const spawn = vi.fn();
    const result = openBrowser("http://x/", { platform: "linux", which: () => null, spawn });
    expect(result).toEqual({ opened: false, reason: "xdg-open not found on PATH" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
