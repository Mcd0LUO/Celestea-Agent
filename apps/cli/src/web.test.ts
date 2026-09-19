import { describe, expect, it, vi } from "vitest";
import { runWeb } from "./web.js";

describe("runWeb (injected server/opener)", () => {
  it("starts the server, prints the URL and opens the browser by default", () => {
    const stop = vi.fn(async () => {});
    const start = vi.fn(() => ({
      port: 4567,
      hostname: "127.0.0.1",
      endpointCount: 63,
      listening: Promise.resolve({ port: 4567, hostname: "127.0.0.1" }),
      stop,
    }));
    const open = vi.fn(() => ({ opened: true as const, command: "xdg-open", args: ["http://127.0.0.1:4567/"] }));
    const signals: string[] = [];
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: true }, {
      env: { CELESTEA_HOME: "/tmp/h-web-test" },
      verify: () => {},
      start,
      open,
      onSignal: (signal) => signals.push(signal),
    });
    expect(result.url).toBe("http://127.0.0.1:4567/");
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:4567/");
    expect(signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ port: 0, hostname: "127.0.0.1" }));
  });
  it("does not open the browser with --no-open", () => {
    const open = vi.fn();
    const result = runWeb({ port: 0, bind: "127.0.0.1", open: false }, {
      env: { CELESTEA_HOME: "/tmp/h-web-test" },
      verify: () => {},
      start: () => ({
        port: 0,
        hostname: "127.0.0.1",
        endpointCount: 63,
        listening: Promise.resolve({ port: 0, hostname: "127.0.0.1" }),
        stop: async () => {},
      }),
      open,
      onSignal: () => {},
    });
    expect(open).not.toHaveBeenCalled();
    expect(result.guidance.join("\n")).toContain("providers.json");
  });
});
