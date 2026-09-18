/**
 * W779 T2 — session/workspace naming rules that are pure functions.
 *
 * `stripCreationSuffix` is what stops `main-1789192174.492000000` and
 * `mode-std-1789116349.532000000` from reaching the GUI: a session directory
 * name is a uniqueness trick (`<sanitized title>-<secs>.<nanos>[-<n>]`), not a
 * name a human wrote.
 */

import { describe, expect, it } from "vitest";

import { CELESTEA_DIR, liveDirCandidates, sanitizeComponent, sessionDirName, SESSIONS_SUBDIR, sessionsRoot, stripCreationSuffix, timestampSuffix } from "./session-id.js";

describe("W779 T2 · stripCreationSuffix", () => {
  it("strips the <secs>.<nanos> creation tail of a real session dir", () => {
    expect(stripCreationSuffix("main-1789192174.492000000")).toBe("main");
    expect(stripCreationSuffix("mode-std-1789116349.532000000")).toBe("mode-std");
    expect(stripCreationSuffix("我的_会话-1700000000.0")).toBe("我的_会话");
  });

  it("strips the uniqueDir collision counter as well", () => {
    expect(stripCreationSuffix("v2-1-1700000000.0-2")).toBe("v2-1");
    expect(stripCreationSuffix("alpha-1700000000.0-1")).toBe("alpha");
    expect(stripCreationSuffix("alpha-1700000000.0-1000")).toBe("alpha");
  });

  it("leaves a name that merely ends in digits alone", () => {
    expect(stripCreationSuffix("plain")).toBe("plain");
    expect(stripCreationSuffix("报告-2024")).toBe("报告-2024");
    expect(stripCreationSuffix("v1.2")).toBe("v1.2");
    expect(stripCreationSuffix("sprint-42-x")).toBe("sprint-42-x");
  });

  it("never returns an empty name (a suffix-only dir keeps itself)", () => {
    expect(stripCreationSuffix("1700000000.0")).toBe("1700000000.0");
    expect(stripCreationSuffix("-1700000000.0")).toBe("-1700000000.0");
    expect(stripCreationSuffix("")).toBe("");
  });

  it("round-trips what sessionDirName mints (the rule and the maker agree)", () => {
    for (const title of ["main", "我的 会话", "v2-1", "报告-2024"]) {
      expect(stripCreationSuffix(sessionDirName(title, 1_700_000_000_000))).toBe(sanitizeComponent(title));
    }
    expect(sessionDirName("main", 1_700_000_000_000)).toBe(`main-${timestampSuffix(1_700_000_000_000)}`);
  });
});

describe("W877 slice A · new-layout session paths", () => {
  it("exposes the .celestea/sessions vocabulary", () => {
    expect(CELESTEA_DIR).toBe(".celestea");
    expect(SESSIONS_SUBDIR).toBe("sessions");
    expect(sessionsRoot("/ws")).toBe("/ws/.celestea/sessions");
  });

  it("liveDirCandidates probes the NEW layout first and the legacy root second", () => {
    expect(liveDirCandidates("/ws", "alpha")).toEqual(["/ws/.celestea/sessions/alpha", "/ws/alpha"]);
    expect(liveDirCandidates("/ws", "报告-2024")).toEqual(["/ws/.celestea/sessions/报告-2024", "/ws/报告-2024"]);
  });
});
