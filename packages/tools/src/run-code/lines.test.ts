import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { TIMED_OUT } from "../sandbox/async.js";
import {
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  MAX_SUB_CALLS,
  MAX_SUB_OUTPUT_BYTES,
  SDK_TOOLS,
  clampTimeoutMs,
  resolveTimeoutMs,
  runCodeConfig,
  runCodeConfigFromEnv,
} from "./limits.js";
import { LineReader, appendBounded, jsonByteLength, safeUtf8, tail, truncateValue, utf8Prefix } from "./lines.js";

/** A reader over a controllable byte stream (the child's stdout stand-in). */
function reader(maxLineBytes = 64): { reader: LineReader; stream: PassThrough } {
  const stream = new PassThrough();
  return { reader: new LineReader(stream, maxLineBytes), stream };
}

describe("LineReader", () => {
  it("frames newline-terminated lines across chunk boundaries", async () => {
    const { reader: r, stream } = reader();
    stream.write("he");
    stream.write("llo\nwo");
    stream.write("rld\n");
    expect(await r.next(200)).toEqual({ text: "hello", truncated: false });
    expect(await r.next(200)).toEqual({ text: "world", truncated: false });
  });

  it("reports EOF (null) and drops a partial tail without a newline", async () => {
    const { reader: r, stream } = reader();
    stream.write("complete\npartial");
    stream.end();
    expect(await r.next(200)).toEqual({ text: "complete", truncated: false });
    expect(await r.next(200)).toBeNull();
  });

  it("truncates an over-long line, drains it and keeps parsing after it", async () => {
    const { reader: r, stream } = reader(4);
    stream.write("abcdefgh\nnext\n");
    expect(await r.next(200)).toEqual({ text: "abcd", truncated: true });
    expect(await r.next(200)).toEqual({ text: "next", truncated: false });
  });

  it("returns TIMED_OUT while the child stays silent", async () => {
    const { reader: r, stream } = reader();
    expect(await r.next(30)).toBe(TIMED_OUT);
    stream.write("late\n");
    expect(await r.next(200)).toEqual({ text: "late", truncated: false });
  });

  it("treats a null stream as immediate EOF (no stdout pipe)", async () => {
    const r = new LineReader(null, 64);
    expect(await r.next(10)).toBeNull();
  });
});

describe("UTF-8 safe budgets", () => {
  it("never splits a multi-byte character", () => {
    const bytes = Buffer.from("héllo", "utf8");
    expect(safeUtf8(bytes.subarray(0, 2))).toBe("h");
    expect(utf8Prefix("héllo", 2)).toBe("h");
    expect(utf8Prefix("héllo", 3)).toBe("hé");
    expect(utf8Prefix("héllo", 0)).toBe("");
    expect(utf8Prefix("héllo", 99)).toBe("héllo");
    expect(safeUtf8(Buffer.from("×", "utf8"))).toBe("×");
  });

  it("appends up to the byte budget and reports the cut", () => {
    const grown = appendBounded("ab", "cd", 8);
    expect(grown).toEqual({ text: "abcd", truncated: false });
    const cut = appendBounded("ab", "cdef", 4);
    expect(cut).toEqual({ text: "abcd", truncated: true });
    const full = appendBounded("abcd", "ef", 4);
    expect(full).toEqual({ text: "abcd", truncated: true });
    expect(appendBounded("ab", "", 4)).toEqual({ text: "ab", truncated: false });
    expect(appendBounded("", "héllo", 3)).toEqual({ text: "hé", truncated: true });
  });

  it("measures serialized values in bytes and rejects non-JSON values", () => {
    expect(jsonByteLength("héllo")).toBe(8); // 6 bytes + 2 quotes
    expect(jsonByteLength({ a: 1 })).toBe(7);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(jsonByteLength(circular)).toBeNull();
  });

  it("truncates strings by prefix and collapses unsplittable values", () => {
    expect(truncateValue("x".repeat(10), 4)).toBe("xxxx");
    expect(truncateValue("héllo", 3)).toBe("hé");
    expect(truncateValue({ a: 1 }, 64)).toEqual({ a: 1 });
    expect(truncateValue({ a: "x".repeat(64) }, 8)).toBe(
      "[run_code] sub-call output exceeded the budget; value dropped",
    );
    expect(truncateValue(12345, 2)).toBe("[run_code] sub-call output exceeded the budget; value dropped");
  });

  it("tails by code point for failure messages", () => {
    expect(tail("abcdef", 3)).toBe("def");
    expect(tail("abc", 9)).toBe("abc");
    expect(tail("héllo", 2)).toBe("lo");
  });
});

describe("limits + config", () => {
  it("freezes the P0 hard limits and the SDK whitelist", () => {
    expect(MAX_SUB_CALLS).toBe(20);
    expect(MAX_SUB_OUTPUT_BYTES).toBe(262_144);
    expect(MAX_LOG_BYTES).toBe(65_536);
    expect(MAX_LINE_BYTES).toBe(1_048_576);
    expect(SDK_TOOLS).toEqual(["read_file", "write_file", "list_dir", "run_shell"]);
  });

  it("defaults to 120s / 20 sub-calls / 256KiB / 64KiB", () => {
    expect(runCodeConfig()).toEqual({
      timeoutMs: 120_000,
      maxSubCalls: 20,
      maxSubOutputBytes: 262_144,
      maxLogBytes: 65_536,
    });
    expect(runCodeConfig({ timeoutMs: 900 })).toMatchObject({ timeoutMs: 900, maxSubCalls: 20 });
  });

  it("reads CELAESTEA_RUN_CODE_TIMEOUT_MS and clamps it to [1, 120000]", () => {
    expect(runCodeConfigFromEnv({ CELAESTEA_RUN_CODE_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
    expect(runCodeConfigFromEnv({ CELAESTEA_RUN_CODE_TIMEOUT_MS: "999999" }).timeoutMs).toBe(120_000);
    expect(runCodeConfigFromEnv({ CELAESTEA_RUN_CODE_TIMEOUT_MS: "0" }).timeoutMs).toBe(1);
    expect(runCodeConfigFromEnv({ CELAESTEA_RUN_CODE_TIMEOUT_MS: "soon" }).timeoutMs).toBe(120_000);
    expect(clampTimeoutMs(2.7)).toBe(2);
  });

  it("validates a per-call timeout_ms (default, bounds, integer)", () => {
    const config = runCodeConfig();
    expect(resolveTimeoutMs(undefined, config)).toBe(120_000);
    expect(resolveTimeoutMs(800, config)).toBe(800);
    expect(() => resolveTimeoutMs(0, config)).toThrow(/timeout_ms must be >= 1, got 0/);
    expect(() => resolveTimeoutMs(1.5, config)).toThrow(/timeout_ms must be an integer/);
    expect(() => resolveTimeoutMs(120_001, config)).toThrow(/exceeds the run_code maximum 120000ms/);
  });
});
