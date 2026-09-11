import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_MODE, SESSION_MODES, effectiveMode, isSessionMode, parseMode, validateMode } from "./mode.js";

/**
 * W729 P0 §5.1 #1 (K3): the mode vocabulary is ONE module-level table. These
 * tests pin the literals (a new mode is a contract change, not an implementation
 * detail) and the two read/write disciplines the rest of the host relies on.
 */
describe("session mode vocabulary", () => {
  it("freezes the two literals and the default", () => {
    expect(SESSION_MODES).toEqual(["standard", "execution"]);
    expect(DEFAULT_SESSION_MODE).toBe("standard");
    expect(isSessionMode("execution")).toBe(true);
    expect(isSessionMode("fast")).toBe(false);
  });

  it("parseMode is strict: anything that is not a literal is null", () => {
    expect(parseMode("standard")).toBe("standard");
    expect(parseMode("execution")).toBe("execution");
    for (const raw of ["fast", "", "STANDARD", " Execution ", null, undefined, 7, {}, ["standard"]]) {
      expect(parseMode(raw), String(raw)).toBeNull();
    }
  });

  it("effectiveMode degrades every non-literal to the default (K8/U9)", () => {
    expect(effectiveMode("execution")).toBe("execution");
    for (const raw of ["", "fast", undefined, null, 1]) expect(effectiveMode(raw)).toBe("standard");
  });

  it("validateMode returns the frozen 400 text", () => {
    expect(validateMode("execution")).toBeNull();
    expect(validateMode("standard")).toBeNull();
    expect(validateMode("fast")).toBe("invalid mode: fast");
    expect(validateMode("Execution")).toBe("invalid mode: Execution");
  });
});
