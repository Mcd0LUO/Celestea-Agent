/**
 * W1504 - the transcript memo (session-log-memo.ts) and its production caller
 * (SessionsStore.messages).
 *
 * The memo is a PURE CACHE, so every assertion is one of two shapes:
 *   - equivalence - the memoized answer equals the UNMEMOIZED projection;
 *   - staleness   - a changed file is re-read, never served from the entry.
 * "reads" counts real file reads: that is how a HIT is told apart from a miss
 * that happens to return the same bytes.
 *
 * Timestamps are forced with utimesSync wherever a test needs a specific
 * relationship between two revisions - the production mtime has nanosecond
 * resolution, so "same millisecond" is not something a test can hope to hit by
 * luck, it has to be constructed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionJsonl, projectMessages, segmentPathsFor } from "@celestea/session";
import type { StudioMessage } from "@celestea/core";
import { SessionsStore, type ResolvedSession } from "./sessions.js";
import { TranscriptMemo, TRANSCRIPT_MEMO_MAX, TRANSCRIPT_READ_ATTEMPTS, type TranscriptIo } from "./session-log-memo.js";
import { WorkspacesStore } from "./workspaces.js";

const LOG = [
  JSON.stringify({ type: "turn_start", id: "turn-1" }),
  JSON.stringify({ type: "user_message", text: "hello" }),
  JSON.stringify({ type: "assistant_message", text: "hi" }),
].join("\n") + "\n";
const LOG_OTHER = LOG.replace("hello", "HELLO");
const T0 = 1_700_000_000_000;

/** The unmemoized projection - the oracle the memo must never disagree with. */
function oracle(text: string): StudioMessage[] {
  return projectMessages(parseSessionJsonl(text).events);
}

let root: string;
let logPath: string;
let reads: Map<string, number>;

/** Production node:fs behind the injectable seam, plus a per-path read counter. */
const io: TranscriptIo = {
  read: (path) => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    return readFileSync(path, "utf8");
  },
  // Production asks the session package for the segment set; tests use the same
  // helper so a fixture with a `.1` behaves exactly like production.
  segments: (path) => segmentPathsFor(path),
  stat: (path) => {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
};

const readsOf = (path: string): number => reads.get(path) ?? 0;

/** Force an exact mtime, so revision comparisons are constructed, not raced. */
function stamp(path: string, mtimeMs = T0): void {
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

function oracleOf(path: string): StudioMessage[] {
  return oracle(readFileSync(path, "utf8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memo-"));
  logPath = join(root, "cli-main.jsonl");
  reads = new Map();
  writeFileSync(logPath, LOG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("W1504 - equivalence: memoized === unmemoized", () => {
  it("cold and warm reads both equal the unmemoized projection", () => {
    const memo = new TranscriptMemo(io);
    const cold = memo.read(logPath);
    const warm = memo.read(logPath);
    expect(cold).toEqual(oracleOf(logPath));
    expect(warm).toEqual(oracleOf(logPath));
    expect(warm).toEqual(cold);
    expect(warm).toBe(cold); // a hit reuses the array instead of re-allocating
    expect(readsOf(logPath)).toBe(1);
  });

  it("a hit is only taken when BOTH mtime and size match (cold read after a rewrite)", () => {
    const memo = new TranscriptMemo(io);
    expect(memo.read(logPath)).toEqual([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
    writeFileSync(logPath, LOG_OTHER);
    stamp(logPath, T0 + 1000);
    expect(memo.read(logPath)).toEqual([{ role: "user", content: "HELLO" }, { role: "assistant", content: "hi" }]);
    expect(readsOf(logPath)).toBe(2);
  });
});

describe("W1504 - staleness: a changed file is re-parsed", () => {
  it("an append is visible on the next read (mtime alone would not be enough)", () => {
    const memo = new TranscriptMemo(io);
    stamp(logPath, T0);
    memo.read(logPath);
    const appended = LOG + JSON.stringify({ type: "user_message", text: "again" }) + "\n";
    writeFileSync(logPath, appended);
    stamp(logPath, T0); // same mtime on purpose: SIZE is the field that saves us
    expect(memo.read(logPath)).toEqual(oracleOf(logPath));
    expect(memo.read(logPath)).toHaveLength(3);
    expect(readsOf(logPath)).toBe(2);
  });

  it("a same-size rewrite is visible on the next read (size alone would not be enough)", () => {
    const memo = new TranscriptMemo(io);
    expect(Buffer.byteLength(LOG_OTHER)).toBe(Buffer.byteLength(LOG));
    stamp(logPath, T0);
    memo.read(logPath);
    writeFileSync(logPath, LOG_OTHER);
    stamp(logPath, T0 + 1); // same size on purpose: MTIME is the field that saves us
    expect(memo.read(logPath)).toEqual([{ role: "user", content: "HELLO" }, { role: "assistant", content: "hi" }]);
    expect(readsOf(logPath)).toBe(2);
  });

  it("a torn tail stays dropped after a re-read (projection semantics unchanged)", () => {
    const memo = new TranscriptMemo(io);
    memo.read(logPath);
    writeFileSync(logPath, LOG + '{"type":"user_mess');
    expect(memo.read(logPath)).toEqual(oracleOf(logPath));
    expect(memo.read(logPath)).toEqual([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
  });

  it("a DELETED log is not resurrected from the entry (ENOENT propagates)", () => {
    const memo = new TranscriptMemo(io);
    memo.read(logPath);
    rmSync(logPath);
    expect(() => memo.read(logPath)).toThrow(/ENOENT/);
  });

  it("two paths never share an entry (a moved session is re-read at its new path)", () => {
    const memo = new TranscriptMemo(io);
    const other = join(root, "elsewhere.jsonl");
    writeFileSync(other, LOG_OTHER);
    expect(memo.read(logPath)).toEqual(oracleOf(logPath));
    expect(memo.read(other)).toEqual(oracleOf(other));
    expect(memo.read(logPath)).toEqual([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
    expect(readsOf(logPath)).toBe(1);
    expect(readsOf(other)).toBe(1);
  });
});

describe("W1504 - stability retry: never cache a snapshot of a file being written", () => {
  it("re-reads when the file grows under the read, and memoizes only the settled pass", () => {
    let growth = 0;
    const racing: TranscriptIo = {
      read: (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        const text = readFileSync(path, "utf8");
        if (growth < 2) {
          growth += 1;
          writeFileSync(path, text + JSON.stringify({ type: "user_message", text: "g" + growth }) + "\n");
        }
        return text;
      },
      segments: io.segments,
      stat: io.stat,
    };
    const memo = new TranscriptMemo(racing);
    expect(memo.read(logPath)).toEqual(oracleOf(logPath));
    expect(readsOf(logPath)).toBe(TRANSCRIPT_READ_ATTEMPTS);
    // The settled pass WAS memoized: an unchanged file is not read a fourth time.
    expect(memo.read(logPath)).toEqual(oracleOf(logPath));
    expect(readsOf(logPath)).toBe(TRANSCRIPT_READ_ATTEMPTS);
  });

  it("gives up after the attempt budget and returns the last read UNMEMOIZED", () => {
    let last = "";
    const alwaysGrowing: TranscriptIo = {
      read: (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        last = readFileSync(path, "utf8");
        writeFileSync(path, last + JSON.stringify({ type: "user_message", text: "n" + readsOf(path) }) + "\n");
        return last;
      },
      segments: io.segments,
      stat: io.stat,
    };
    const memo = new TranscriptMemo(alwaysGrowing);
    const out = memo.read(logPath);
    expect(readsOf(logPath)).toBe(TRANSCRIPT_READ_ATTEMPTS);
    expect(out).toEqual(oracle(last)); // a valid PREFIX of the log, never garbage
    expect(memo.size).toBe(0); // an unproven revision is never cached
  });
});

describe("W1504 - the memo is bounded (LRU)", () => {
  function plantMany(count: number): string[] {
    const paths: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const path = join(root, "s-" + i + ".jsonl");
      writeFileSync(path, LOG);
      paths.push(path);
    }
    return paths;
  }

  it("stays at the cap no matter how many sessions are read", () => {
    const memo = new TranscriptMemo(io);
    for (const path of plantMany(40)) memo.read(path);
    expect(memo.size).toBe(TRANSCRIPT_MEMO_MAX);
    expect(TRANSCRIPT_MEMO_MAX).toBeLessThanOrEqual(8); // a memo, not a second store
  });

  it("evicts the least recently used entry", () => {
    const memo = new TranscriptMemo(io);
    const paths = plantMany(TRANSCRIPT_MEMO_MAX + 1);
    for (const path of paths) memo.read(path);
    const oldest = paths[0] as string;
    const newest = paths[paths.length - 1] as string;
    expect(readsOf(oldest)).toBe(1);
    memo.read(oldest); // evicted -> a real read
    expect(readsOf(oldest)).toBe(2);
    memo.read(newest); // still cached -> no read
    expect(readsOf(newest)).toBe(1);
  });

  it("a HIT refreshes recency (eviction is not insertion-ordered)", () => {
    const memo = new TranscriptMemo(io);
    const paths = plantMany(TRANSCRIPT_MEMO_MAX + 1);
    const first = paths[0] as string;
    const second = paths[1] as string;
    const fresh = paths[paths.length - 1] as string;
    for (const path of paths.slice(0, TRANSCRIPT_MEMO_MAX)) memo.read(path);
    memo.read(first); // refresh the oldest
    memo.read(fresh); // pushes out `second`, not `first`
    expect(readsOf(second)).toBe(1);
    memo.read(second);
    expect(readsOf(second)).toBe(2);
    memo.read(first);
    expect(readsOf(first)).toBe(1);
  });

  it("forget() drops an entry even when the file itself never changed", () => {
    const memo = new TranscriptMemo(io);
    memo.read(logPath);
    memo.forget(logPath);
    memo.read(logPath);
    expect(readsOf(logPath)).toBe(2);
  });
});

describe("W1504 - SessionsStore.messages() integration", () => {
  /** A store whose only session is a legacy <ws>/alpha holding [log]. */
  function storeWithLog(log: string): { store: SessionsStore; resolved: ResolvedSession; file: string } {
    const wsRoot = join(root, "ws");
    const dir = join(wsRoot, "alpha");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "cli-main.jsonl");
    writeFileSync(file, log);
    const registry = new WorkspacesStore(join(root, "workspaces.json"));
    registry.register(wsRoot);
    const store = new SessionsStore(registry, () => T0);
    const resolved = store.require("ws/alpha");
    if (!resolved.ok) throw new Error("plant failed: " + resolved.error);
    return { store, resolved: resolved.value, file };
  }

  it("POST /api/clear: never serves the pre-clear projection", () => {
    const { store, resolved } = storeWithLog(LOG);
    expect(store.messages(resolved)).toEqual([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
    expect(store.truncate(resolved)).toEqual({ ok: true, value: undefined });
    expect(store.messages(resolved)).toEqual([]);
  });

  it("an append between two reads is visible (no stale projection)", () => {
    const { store, resolved, file } = storeWithLog(LOG);
    const first = store.messages(resolved);
    writeFileSync(file, LOG + JSON.stringify({ type: "user_message", text: "again" }) + "\n");
    const second = store.messages(resolved);
    expect(second).toEqual([...first, { role: "user", content: "again" }]);
    expect(second).not.toBe(first);
  });

  /**
   * CLOSED (was an `it.fails` tripwire while the gap was open).
   *
   * W1503 rolls a session log to `<path>.1`, `.2`, … at 16 MiB. The old body read
   * ONE file, so every rolled segment vanished from the response — measured: 3
   * messages split "2 in `.1` + 1 in the current file" came back as 1.
   *
   * Now `messages()` replays the whole segment set, so the projection equals the
   * concatenation. The assertion is a plain `it` again: it is RED the moment
   * segment reading regresses.
   */
  it("a rotated session projects EVERY segment (oldest first, then current)", () => {
    const { store, resolved, file } = storeWithLog(LOG);
    writeFileSync(file + ".1", LOG_OTHER);
    expect(store.messages(resolved)).toEqual([...oracleOf(file + ".1"), ...oracleOf(file)]);
  });

  it("a SECOND roll is seen too (the segment SET is the key, not one file)", () => {
    const { store, resolved, file } = storeWithLog(LOG);
    // First roll: `.1` (generation 1, the OLDEST) holds the old tail.
    writeFileSync(file + ".1", LOG_OTHER);
    const afterFirst = store.messages(resolved);
    expect(afterFirst).toEqual([...oracleOf(file + ".1"), ...oracleOf(file)]);
    // Second roll: W1503 names segments by GENERATION and never shifts them —
    // `.2` is appended as the newest, `.1` stays put (that is the whole reason it
    // uses generations instead of the ledger's replaced `.1`: replacing would
    // delete history). A single-file key cannot see this at all, because the
    // CURRENT file is untouched by the roll.
    writeFileSync(file + ".2", LOG);
    const afterSecond = store.messages(resolved);
    expect(afterSecond).toEqual([...oracleOf(file + ".1"), ...oracleOf(file + ".2"), ...oracleOf(file)]);
    // The memo did NOT serve the first-roll projection for the second-roll set.
    expect(afterSecond).not.toEqual(afterFirst);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  });

  it("a roll that empties the current file is not confused with an empty session", () => {
    // The trap a single-file key falls into: after a roll the current file is 0
    // bytes, which is exactly what an untouched empty session looks like.
    const { store, resolved, file } = storeWithLog(LOG);
    expect(store.messages(resolved)).toHaveLength(2); // warm the entry
    writeFileSync(file + ".1", LOG);
    writeFileSync(file, ""); // the roll: everything moved to `.1`
    expect(store.messages(resolved)).toEqual(oracleOf(file + ".1"));
  });

  it("a deleted session is not resurrected from the memo", () => {
    const { store, resolved, file } = storeWithLog(LOG);
    expect(store.messages(resolved)).toHaveLength(2);
    rmSync(file);
    expect(() => store.messages(resolved)).toThrow();
  });
});
