// @vitest-environment node
/**
 * W891 — the Windows rename-retry helper. Injected rename/sleep keep it a pure
 * unit test (no real filesystem, no real waiting).
 */
import { describe, expect, it } from "vitest";
import { isTransientRenameError, renameWithRetry, sleepSync } from "./fs-atomic.js";

function err(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("W891 renameWithRetry", () => {
  it("succeeds on the first try without sleeping", () => {
    const calls: Array<[string, string]> = [];
    const slept: number[] = [];
    renameWithRetry("a", "b", { rename: (f, t) => calls.push([f, t]), sleep: (ms) => slept.push(ms) });
    expect(calls).toEqual([["a", "b"]]);
    expect(slept).toEqual([]);
  });

  it("retries a transient EPERM then succeeds with linear backoff", () => {
    let n = 0;
    const slept: number[] = [];
    renameWithRetry("a", "b", {
      attempts: 5,
      delayMs: 10,
      rename: () => { n++; if (n <= 2) throw err("EPERM"); },
      sleep: (ms) => slept.push(ms),
    });
    expect(n).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it("throws a non-transient error immediately", () => {
    let n = 0;
    expect(() => renameWithRetry("a", "b", { rename: () => { n++; throw err("ENOENT"); } })).toThrow("ENOENT");
    expect(n).toBe(1);
  });

  it("exhausts attempts and rethrows the last transient error", () => {
    let n = 0;
    expect(() => renameWithRetry("a", "b", { attempts: 3, delayMs: 1, rename: () => { n++; throw err("EBUSY"); }, sleep: () => {} })).toThrow("EBUSY");
    expect(n).toBe(3);
  });

  it("classifies only the transient Windows codes", () => {
    expect(isTransientRenameError(err("EPERM"))).toBe(true);
    expect(isTransientRenameError(err("EBUSY"))).toBe(true);
    expect(isTransientRenameError(err("EACCES"))).toBe(true);
    expect(isTransientRenameError(err("ENOTEMPTY"))).toBe(true);
    expect(isTransientRenameError(err("ENOENT"))).toBe(false);
    expect(isTransientRenameError(new Error("x"))).toBe(false);
  });

  it("sleepSync blocks for a non-negative duration", () => {
    const t0 = Date.now();
    sleepSync(15);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
    sleepSync(0);
  });
});
