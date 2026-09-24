/**
 * Session-log capacity rotation (P0-2, W1503).
 *
 * The ONE assertion that matters is the equivalence: a rotated log must project
 * EXACTLY what a never-rotated log projects (`events()` / `deriveMessages()`),
 * because rotation is a storage detail and `cli-main.jsonl` is the source of
 * truth for the model-visible history. Everything else here pins the mechanism
 * that makes the equivalence true: the roll happens BEFORE the write, every
 * rolled segment is kept (a roll never deletes history), a torn segment is
 * repaired in ITSELF, and the turn counter / `open()` replay span all segments.
 *
 * The threshold is injected (a few hundred bytes) so REAL rolls happen without
 * writing 16 MiB; the production default is asserted separately.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { serializeSessionJsonl } from "../jsonl.js";
import { SESSION_LOG_MAX_BYTES, filePathFor, nextRolledPathFor, rolledPathsFor, segmentPathsFor } from "./file.js";
import { PersistentSessionLog, type PersistentOptions } from "./persistent.js";

const SESSION = "cli-main";
/** Small enough that a handful of records crosses it, large enough for several. */
const TINY = 400;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "celestea-rotation-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function opts(maxBytes: number): PersistentOptions {
  return { flushEachAppend: true, syncEachAppend: false, maxBytes };
}

/** A stream with turn boundaries, thinking, tool traffic and user/assistant text. */
function stream(turns = 6, filler = "x".repeat(60), offset = 0): SessionEvent[] {
  const out: SessionEvent[] = [{ type: "user_message", text: `开场 ${offset} ${filler}` }];
  for (let t = 0; t < turns; t++) {
    const n = offset + t;
    out.push({ type: "turn_start", id: `turn-${n}` });
    out.push({ type: "thinking_delta", text: `思考 ${n} ${filler}` });
    out.push({ type: "tool_call", id: `c${n}`, name: "run_shell", args: { command: `echo ${n} ${filler}` } });
    out.push({ type: "tool_result", id: `c${n}`, value: { stdout: filler }, error: null });
    out.push({ type: "assistant_message", text: `答复 ${n} ${filler}` });
    out.push({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
  }
  return out;
}

/** Write the whole stream through a log with the given threshold, then reopen. */
function write(dir: string, events: readonly SessionEvent[], maxBytes: number): PersistentSessionLog {
  const log = PersistentSessionLog.open(dir, SESSION, opts(maxBytes));
  for (const ev of events) log.append(ev);
  log.close();
  return PersistentSessionLog.open(dir, SESSION, opts(maxBytes));
}

/** The segments of `path` concatenated, oldest first (what a reader must see). */
function concatenated(path: string): string {
  return segmentPathsFor(path)
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "utf8"))
    .join("");
}

describe("session log rotation", () => {
  it("keeps the production threshold at the 16 MiB audit-log precedent", () => {
    // Same order as USAGE_LEDGER_MAX_BYTES (W785 §3.3 P1 ④) and the three audit
    // logs that rotate at 16 MiB. Changing it is a deliberate act, not a drift.
    expect(SESSION_LOG_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("projects a rotated log EXACTLY like a never-rotated one (events + deriveMessages)", () => {
    const events = stream();
    const plainDir = tempDir();
    const rolledDir = tempDir();
    const plain = write(plainDir, events, Number.POSITIVE_INFINITY);
    const rolled = write(rolledDir, events, TINY);
    const rolledPath = filePathFor(rolledDir, SESSION);
    const plainPath = filePathFor(plainDir, SESSION);

    // The fixture must ACTUALLY rotate, otherwise this test proves nothing.
    expect(rolledPathsFor(rolledPath).length).toBeGreaterThan(0);
    expect(statSync(rolledPath).size).toBeLessThan(statSync(plainPath).size);

    // Byte-level: the segments concatenated ARE the never-rotated stream.
    expect(concatenated(rolledPath)).toBe(readFileSync(plainPath, "utf8"));

    // Projection-level: the equivalence the rotation must not break.
    expect(rolled.events()).toEqual(plain.events());
    expect(rolled.events()).toEqual(events);
    expect(rolled.deriveMessages()).toEqual(plain.deriveMessages());
    // Turn identity stays continuous across the segment boundary.
    expect(rolled.nextTurnId()).toBe(plain.nextTurnId());
    expect(rolled.nextTurnId()).toBe(plain.nextTurnId());
    plain.close();
    rolled.close();
  });

  it("keeps EVERY segment across repeated rolls (history is never deleted)", () => {
    // The ledger's single replaced `.1` would drop the conversation start here.
    const first = stream(20, "y".repeat(120));
    const second = stream(20, "z".repeat(120), 20);
    const all = [...first, ...second];
    const plainDir = tempDir();
    const rolledDir = tempDir();
    const plain = write(plainDir, all, Number.POSITIVE_INFINITY);
    const rolledPath = filePathFor(rolledDir, SESSION);

    const log = PersistentSessionLog.open(rolledDir, SESSION, opts(TINY));
    for (const ev of first) log.append(ev);
    for (const ev of second) log.append(ev);
    log.close();

    // More than one roll happened: generations accumulate instead of replacing.
    expect(rolledPathsFor(rolledPath).length).toBeGreaterThan(1);
    expect(concatenated(rolledPath)).toBe(readFileSync(filePathFor(plainDir, SESSION), "utf8"));
    const reopened = PersistentSessionLog.open(rolledDir, SESSION, opts(TINY));
    expect(reopened.events()).toEqual(all);
    expect(reopened.events()).toEqual(plain.events());
    expect(reopened.deriveMessages()).toEqual(plain.deriveMessages());
    plain.close();
    reopened.close();
  });

  it("rolls BEFORE the write, so the rolled segment is a complete prefix", () => {
    const events = stream();
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    const log = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    let boundary = -1;
    for (let i = 0; i < events.length; i++) {
      if (existsSync(path) && statSync(path).size >= TINY && boundary === -1) boundary = i;
      log.append(events[i]!);
    }
    expect(boundary).toBeGreaterThan(0);
    // The first segment holds EXACTLY the records written before the boundary:
    // the check is pre-write (a post-write check would have rolled one record
    // later and left an oversize record inside the rolled segment).
    expect(readFileSync(`${path}.1`, "utf8")).toBe(serializeSessionJsonl(events.slice(0, boundary)));
    expect(concatenated(path)).toBe(serializeSessionJsonl(events));
    // The live view spans the segments (not just the in-memory tail).
    expect(log.events()).toEqual(events);
    log.close();
  });

  it("restores the turn counter across the segment boundary", () => {
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    const log = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    for (const ev of stream()) log.append(ev);
    expect(rolledPathsFor(path).length).toBeGreaterThan(0);
    log.close();
    const reopened = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    // stream() ends at turn-5; the counter must continue from disk, not restart.
    expect(reopened.nextTurnId()).toBe("turn-6");
    reopened.close();
  });

  it("clear() drops every segment so no history can be resurrected", () => {
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    const log = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    for (const ev of stream(20, "y".repeat(120))) log.append(ev);
    expect(rolledPathsFor(path).length).toBeGreaterThan(0);
    log.clear();
    expect(rolledPathsFor(path)).toEqual([]);
    expect(log.events()).toEqual([]);
    log.append({ type: "user_message", text: "fresh" });
    log.close();
    const reopened = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    expect(reopened.events()).toEqual([{ type: "user_message", text: "fresh" }]);
    expect(reopened.nextTurnId()).toBe("turn-0");
    reopened.close();
  });

});

describe("session log rotation — segment bookkeeping", () => {
  it("rolls at EXACTLY the threshold (the ledger's \"at or above\" comparison)", () => {
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    // A file of exactly TINY bytes: one user_message padded to the threshold.
    const overhead = Buffer.byteLength(JSON.stringify({ type: "user_message", text: "" }), "utf8");
    const line = `${JSON.stringify({ type: "user_message", text: "t".repeat(TINY - 1 - overhead) })}\n`;
    expect(Buffer.byteLength(line, "utf8")).toBe(TINY);
    writeFileSync(path, line);

    const log = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    log.append({ type: "user_message", text: "next" });
    log.close();
    // size >= threshold rolls (the ledger's `size < max` early return): a strict
    // `>` comparison would leave the exact-threshold file in place.
    expect(readFileSync(`${path}.1`, "utf8")).toBe(line);
    expect(readFileSync(path, "utf8")).toBe(serializeSessionJsonl([{ type: "user_message", text: "next" }]));
    const reopened = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    expect(reopened.events()).toEqual([
      { type: "user_message", text: "t".repeat(TINY - 1 - overhead) },
      { type: "user_message", text: "next" },
    ]);
    reopened.close();
  });

  it("never reuses a generation number and ignores non-segment siblings", () => {
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    const name = basename(path);
    // Siblings that must NOT be read as segments (compaction backup / tmp).
    writeFileSync(`${path}.precompact`, "not a segment\n");
    writeFileSync(`${path}.tmp-1234`, "not a segment\n");
    const log = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    for (const ev of stream(20, "y".repeat(120))) log.append(ev);
    log.close();
    const rolled = rolledPathsFor(path);
    expect(rolled.length).toBeGreaterThan(0);
    // Generations are 1..n in ascending order — never reused, never a sibling.
    expect(rolled.every((p, i) => p === `${path}.${i + 1}`)).toBe(true);
    expect(rolled.some((p) => basename(p).includes("precompact") || basename(p).includes("tmp"))).toBe(false);
    expect(nextRolledPathFor(path)).toBe(`${path}.${rolled.length + 1}`);
    // The `every` check above is also the NUMERIC-ordering assertion: this run
    // produced `.10`…`.39`, and a lexicographic sort would have placed `.10`
    // before `.2` (so index 1 would be `${path}.10`, not `${path}.2`).
    expect(rolled[1]).toBe(`${path}.2`);
    expect(rolled[9]).toBe(`${path}.10`);
    expect(segmentPathsFor(path)).toEqual([...rolled, path]);
    const reopened = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    expect(reopened.events()).toEqual(stream(20, "y".repeat(120)));
    reopened.close();
    expect([`${name}.1`, name, `${name}.precompact`, `${name}.tmp-1234`].every((f) => existsSync(join(dir, f)))).toBe(true);
  });

  it("truncates a torn CURRENT file and keeps the rolled segments intact", () => {
    const events = stream();
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    write(dir, events, TINY);
    const rolledBefore = rolledPathsFor(path).map((p) => readFileSync(p, "utf8"));
    expect(rolledBefore.length).toBeGreaterThan(0);
    const good = readFileSync(path, "utf8");
    writeFileSync(path, `${good}{"type":"assistant_message","text":"tor`);

    const reopened = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    // The line number is counted ACROSS the segments (the torn record is the
    // first line after every event already replayed), not restarted per file.
    expect(reopened.tornTail?.line).toBe(events.length + 1);
    expect(reopened.events()).toEqual(events);
    // The tear is repaired in the file that holds it; the segments are untouched.
    expect(readFileSync(path, "utf8")).toBe(good);
    expect(rolledPathsFor(path).map((p) => readFileSync(p, "utf8"))).toEqual(rolledBefore);
    reopened.close();
  });

  it("truncates a torn segment (crash between the roll and the next record)", () => {
    const events = stream(4);
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    write(dir, events, TINY);
    // Model the crash window: the whole stream is in .1, torn mid-record, and
    // the current file was never recreated.
    const whole = concatenated(path);
    rmSync(path);
    for (const segment of rolledPathsFor(path)) rmSync(segment);
    writeFileSync(`${path}.1`, `${whole}{"type":"tool_res`);

    const reopened = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    expect(reopened.tornTail).not.toBeNull();
    expect(reopened.events()).toEqual(events);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(whole);
    expect(readFileSync(path, "utf8")).toBe("");
    // The repaired log appends cleanly and still spans the segments.
    reopened.append({ type: "user_message", text: "after the repair" });
    reopened.close();
    const again = PersistentSessionLog.open(dir, SESSION, opts(TINY));
    expect(again.events()).toEqual([...events, { type: "user_message", text: "after the repair" }]);
    again.close();
  });

  it("does not rotate below the threshold (Infinity disables it)", () => {
    const dir = tempDir();
    const path = filePathFor(dir, SESSION);
    const log = write(dir, stream(), Number.POSITIVE_INFINITY);
    expect(rolledPathsFor(path)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(serializeSessionJsonl(stream()));
    log.close();
  });
});
