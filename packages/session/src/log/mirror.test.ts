/**
 * W9207 — `PersistentSessionLog.events()` serves the in-memory MIRROR.
 *
 * The bug these tests pin (measured on the real implementation): `events()`
 * used to replay the whole segment set from disk on EVERY call —
 * `replaySegments(segmentPathsFor(path)).events` — and it sits on the
 * per-model-step path (`AgentLoop.buildRequest` -> `deriveMessages()`, plus the
 * usage ledger's `beginStep`). A 6.77 MB log measured 45 ms per call with no
 * caching (45.0 / 38.0 / 35.3 ms back to back), i.e. ~664 ms extrapolated at
 * 100 MB and ~0.9 s of synchronous main-thread work per 20-step turn.
 *
 * The two properties that make the fix real, each with its own failure mode:
 *   1. a read replays NOTHING (the mirror is the source of truth) — a
 *      regression to the disk read is caught by the call COUNTER below;
 *   2. the mirror is fed by `append` even when the DISK write failed — a
 *      regression to "derive from disk" silently drops the row from the model
 *      history (the exact P1-2 contract violation).
 *
 * The counter is a `vi.mock` of the sibling `./file.js` (the module whose
 * `replaySegments` is the disk path). `vi.spyOn(node:fs, "readFileSync")` is NOT
 * usable here: an ESM module namespace is not configurable (verified — it throws
 * "Cannot redefine property"), which is also why the mock wraps the REAL
 * implementation and delegates to it rather than stubbing it out.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@celestea/core";

/** Hoisted so the mock factory (itself hoisted) can close over it. */
const counted = vi.hoisted(() => ({ replays: 0 }));

vi.mock("./file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file.js")>();
  return {
    ...actual,
    replaySegments: (paths: readonly string[]): ReturnType<typeof actual.replaySegments> => {
      counted.replays += 1;
      return actual.replaySegments(paths);
    },
  };
});

import { filePathFor, rolledPathsFor, segmentPathsFor } from "./file.js";
import { PersistentSessionLog, type PersistentOptions } from "./persistent.js";

const SESSION = "cli-main";
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  counted.replays = 0;
});

function opts(maxBytes: number): PersistentOptions {
  return { flushEachAppend: true, syncEachAppend: false, maxBytes };
}

/** Enough turn traffic to cross a small threshold several times. */
function stream(turns: number, filler = "x".repeat(60)): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ type: "turn_start", id: `turn-${t}` });
    out.push({ type: "user_message", text: `问 ${t} ${filler}` });
    out.push({ type: "assistant_message", text: `答 ${t} ${filler}` });
    out.push({ type: "turn_end", id: `turn-${t}`, outcome: "completed" });
  }
  return out;
}

describe("W9207 — events() is served from memory, not re-read from disk", () => {
  it("replays NOTHING after open: repeated events()/deriveMessages() are pure memory reads", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, SESSION, opts(Number.POSITIVE_INFINITY));
    for (const ev of stream(3)) log.append(ev);
    // open() is the ONE replay: it seeds the mirror.
    expect(counted.replays).toBe(1);

    for (let i = 0; i < 5; i++) {
      expect(log.events()).toHaveLength(12);
      log.deriveMessages();
    }
    // Not "once more": ZERO more. The old implementation incremented here.
    expect(counted.replays).toBe(1);
    log.close();
  });

  it("an append after open is served from memory too (no re-replay per step)", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, SESSION, opts(Number.POSITIVE_INFINITY));
    log.append({ type: "user_message", text: "first" });
    const baseline = counted.replays;
    for (let i = 0; i < 20; i++) {
      log.append({ type: "assistant_message", text: `chunk ${i}` });
      log.deriveMessages(); // what AgentLoop.buildRequest does once per model step
    }
    expect(counted.replays).toBe(baseline);
    expect(log.events()).toHaveLength(21);
    log.close();
  });

  it("the mirror still spans EVERY segment (rotation semantics unchanged)", () => {
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    const events = stream(20, "y".repeat(120));
    const log = PersistentSessionLog.open(dir, SESSION, opts(400));
    for (const ev of events) log.append(ev);
    // The fixture must ACTUALLY rotate, otherwise this proves nothing.
    expect(rolledPathsFor(path).length).toBeGreaterThan(0);
    // The live view is the concatenation of the segments, in order.
    const fromDisk = segmentPathsFor(path)
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"))
      .join("");
    expect(log.events()).toEqual(events);
    expect(fromDisk.split("\n").filter((l) => l !== "")).toHaveLength(events.length);
    // A fresh open replays the same stream (mirror seed == disk truth).
    log.close();
    const reopened = PersistentSessionLog.open(dir, SESSION, opts(400));
    expect(reopened.events()).toEqual(events);
    reopened.close();
  });

  it("clear() empties the mirror without a replay", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, SESSION, opts(Number.POSITIVE_INFINITY));
    log.append({ type: "user_message", text: "gone" });
    const baseline = counted.replays;
    log.clear();
    expect(log.events()).toEqual([]);
    expect(log.deriveMessages()).toEqual([]);
    expect(counted.replays).toBe(baseline);
    log.close();
  });

  /**
   * The seam contract is "a COPY of the recorded events" — the ARRAY is a copy,
   * exactly as `InMemorySessionLog.events()` (the sibling implementation) has
   * always returned. Element references are therefore SHARED with the mirror;
   * that is the sibling's behaviour too, and it is deliberate here: a deep copy
   * on this accessor would re-introduce the O(n) per-step cost the fix removes.
   *
   * The assertion below is scoped to what is actually promised (the array is
   * not the internal one), and the element-sharing is pinned explicitly so no
   * future reader assumes deep-copy semantics the seam never offered.
   */
  it("returns a COPY of the array (mutating the result cannot change the log's length)", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, SESSION, opts(Number.POSITIVE_INFINITY));
    log.append({ type: "user_message", text: "safe" });
    const first = log.events();
    first.push({ type: "user_message", text: "injected" });
    expect(first).toHaveLength(2);
    // The log itself is untouched: the pushed row never entered the mirror.
    expect(log.events()).toHaveLength(1);
    expect(log.events()).not.toBe(first);

    // Documented shallow-copy property (shared with InMemorySessionLog): the
    // EVENT objects are the mirror's own, so callers must treat them as
    // read-only. No consumer in the repo mutates them (grep-verified).
    const again = log.events();
    expect(again[0]).toBe(first[0]);
    log.close();
  });
});

describe("W9207 — the mirror is the source of truth for a FAILED disk write", () => {
  /**
   * `append` after `close()` is the portable way to drive the failure branch:
   * the descriptor is gone, so the write throws and is caught exactly like a
   * full disk / permission error. The row must still be model-visible — this is
   * the P1-2 contract the old code violated (it derived from disk, so the row
   * vanished while the counter said "degraded").
   */
  it("keeps the row in deriveMessages() when the disk write fails", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, SESSION, opts(Number.POSITIVE_INFINITY));
    log.close(); // fd = null -> the next append's writeSync branch fails

    log.append({ type: "user_message", text: "IMPORTANT" });
    expect(log.writeErrorCount()).toBe(1);
    // The seam's promise: the model-visible history keeps the row.
    expect(log.deriveMessages()).toHaveLength(1);
    expect(log.events()).toEqual([{ type: "user_message", text: "IMPORTANT" }]);
  });

  it("a failed append does not make the file look like it holds the row", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, SESSION, opts(Number.POSITIVE_INFINITY));
    log.close();
    log.append({ type: "user_message", text: "not on disk" });
    // Degraded is honest: memory has it, the file does not.
    expect(readFileSync(filePathFor(dir, SESSION), "utf8")).toBe("");
    expect(log.events()).toHaveLength(1);
  });
});
