/**
 * B3 / W812 P2-1 (R3) — readCapped's off-by-one.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B3 W812 P2-1: a chunk that lands EXACTLY on the cap is complete, not
 * truncated. The old "<" comparison turned the exact-cap case into truncated=true.
 */

import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readCapped } from "./launch.js";

function streamOf(bytes: number): Readable {
  return Readable.from([Buffer.alloc(bytes, 0x41)]);
}

describe("B3 / W812 P2-1: readCapped off-by-one", () => {
  it("reports exactly-cap content as complete and cap+1 as truncated", async () => {
    const cap = 1024;
    const exact = await readCapped(streamOf(cap), cap);
    expect(exact.bytes).toBe(cap);
    expect(exact.truncated).toBe(false);

    const over = await readCapped(streamOf(cap + 1), cap);
    expect(over.bytes).toBe(cap);
    expect(over.truncated).toBe(true);

    const empty = await readCapped(Readable.from([]), cap);
    expect(empty.bytes).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it("does not truncate when chunks land exactly on the cap then EOF arrives", async () => {
    const cap = 16;
    const out = await readCapped(Readable.from([Buffer.alloc(8, 0x41), Buffer.alloc(8, 0x42)]), cap);
    expect(out.bytes).toBe(cap);
    expect(out.truncated).toBe(false);
  });
});
