import { describe, expect, it } from "vitest";
import { DEFAULT_BIND, DEFAULT_PORT, parseArgs } from "./args.js";

describe("celestea CLI args", () => {
  it("defaults to help with no arguments", () => {
    expect(parseArgs([])).toEqual({ ok: true, command: "help" });
  });
  it("parses --version / --help", () => {
    expect(parseArgs(["--version"])).toEqual({ ok: true, command: "version" });
    expect(parseArgs(["-v"])).toEqual({ ok: true, command: "version" });
    expect(parseArgs(["--help"])).toEqual({ ok: true, command: "help" });
  });
  it("parses web defaults", () => {
    expect(parseArgs(["web"])).toEqual({ ok: true, command: "web", options: { port: DEFAULT_PORT, bind: DEFAULT_BIND, open: true } });
  });
  it("parses --port N, --port=N and --no-open", () => {
    expect(parseArgs(["web", "--port", "8080", "--no-open"])).toEqual({ ok: true, command: "web", options: { port: 8080, bind: DEFAULT_BIND, open: false } });
    expect(parseArgs(["web", "--port=0"])).toEqual({ ok: true, command: "web", options: { port: 0, bind: DEFAULT_BIND, open: true } });
  });
  it("parses --bind", () => {
    expect(parseArgs(["web", "--bind", "0.0.0.0"])).toEqual({ ok: true, command: "web", options: { port: DEFAULT_PORT, bind: "0.0.0.0", open: true } });
    expect(parseArgs(["web", "--bind=127.0.0.1"])).toEqual({ ok: true, command: "web", options: { port: DEFAULT_PORT, bind: "127.0.0.1", open: true } });
  });
  it("rejects unknown commands, flags and bad ports (never a silent start)", () => {
    expect(parseArgs(["serve"]).ok).toBe(false);
    expect(parseArgs(["web", "--bogus"]).ok).toBe(false);
    expect(parseArgs(["web", "--port", "abc"]).ok).toBe(false);
    expect(parseArgs(["web", "--port", "70000"]).ok).toBe(false);
    expect(parseArgs(["web", "--port", "80x"]).ok).toBe(false);
    expect(parseArgs(["web", "--bind", ""]).ok).toBe(false);
    expect(parseArgs(["web", "--port"]).ok).toBe(false);
  });
});
