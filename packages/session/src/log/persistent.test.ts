/**
 * PersistentSessionLog — port of the Rust persistent.rs tests: replay +
 * truncate a torn tail, tolerate blank lines, repair a missing final newline,
 * restore the turn counter from disk, and keep derive_messages identical to the
 * in-memory log.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { serializeSessionJsonl } from "../jsonl.js";
import { fileNameFor, filePathFor } from "./file.js";
import { InMemorySessionLog } from "./memory.js";
import { PersistentSessionLog } from "./persistent.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "celestea-session-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const user = (text: string): SessionEvent => ({ type: "user_message", text });
const assistant = (text: string): SessionEvent => ({ type: "assistant_message", text });
const turnStart = (id: string): SessionEvent => ({ type: "turn_start", id });
const turnEnd = (id: string, outcome = "completed"): SessionEvent => ({ type: "turn_end", id, outcome } as SessionEvent);
const call = (id: string): SessionEvent => ({ type: "tool_call", id, name: "run_shell", args: { command: "sleep 1" } });

describe("PersistentSessionLog", () => {
  it("writes one JSON event per line and replays it on reopen", () => {
    const dir = tempDir();
    const log = PersistentSessionLog.open(dir, "session-a");
    const events = [turnStart("turn-0"), user("hi"), assistant("hello"), turnEnd("turn-0")];
    for (const ev of events) log.append(ev);
    log.close();

    const onDisk = readFileSync(join(dir, "session-a.jsonl"), "utf8");
    expect(onDisk).toBe(serializeSessionJsonl(events));

    const reopened = PersistentSessionLog.open(dir, "session-a");
    expect(reopened.events()).toEqual(events);
    expect(reopened.deriveMessages()).toEqual(log.deriveMessages());
    reopened.close();
  });

  it("keeps derive_messages identical to the in-memory log (W210)", () => {
    const dir = tempDir();
    const memory = new InMemorySessionLog();
    const persistent = PersistentSessionLog.open(dir, "session-b");
    for (const ev of [user("go"), call("c1"), { type: "tool_result", id: "c1", value: { ok: true }, error: null } as SessionEvent, assistant("done")]) {
      memory.append(ev);
      persistent.append(ev);
    }
    expect(persistent.deriveMessages()).toEqual(memory.deriveMessages());
    persistent.close();
  });

  it("restores the turn counter from the max id on disk", () => {
    const dir = tempDir();
    const first = PersistentSessionLog.open(dir, "session-c");
    expect(first.nextTurnId()).toBe("turn-0");
    first.append(turnStart("turn-0"));
    first.append(turnEnd("turn-0"));
    first.close();

    const second = PersistentSessionLog.open(dir, "session-c");
    // Never reuses an id that is already persisted (monotonic across restarts).
    expect(second.nextTurnId()).toBe("turn-1");
    second.append(turnStart("turn-1"));
    second.close();

    const third = PersistentSessionLog.open(dir, "session-c");
    expect(third.nextTurnId()).toBe("turn-2");
    third.close();
  });

  it("ignores legacy turn ids when restoring the counter", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "session-d.jsonl"), `${JSON.stringify({ type: "turn_start", id: "t1" })}\n`);
    const log = PersistentSessionLog.open(dir, "session-d");
    expect(log.nextTurnId()).toBe("turn-0");
    log.close();
  });

  it("stops at the first unparsable record and truncates the torn tail", () => {
    const dir = tempDir();
    const path = join(dir, "session-e.jsonl");
    const good = `${JSON.stringify(user("one"))}\n${JSON.stringify(user("two"))}\n`;
    writeFileSync(path, `${good}{"type":"assistant_message","text":"tor`);

    const log = PersistentSessionLog.open(dir, "session-e");
    expect(log.events()).toHaveLength(2);
    expect(log.tornTail?.line).toBe(3);
    expect(readFileSync(path, "utf8")).toBe(good);

    // The repaired file appends cleanly.
    log.append(user("three"));
    log.close();
    const reopened = PersistentSessionLog.open(dir, "session-e");
    expect(reopened.events()).toHaveLength(3);
    expect(reopened.tornTail).toBeNull();
    reopened.close();
  });

  it("tolerates blank lines and keeps them out of the event list", () => {
    const dir = tempDir();
    const path = join(dir, "session-f.jsonl");
    const raw = `\n${JSON.stringify(user("one"))}\n\n\n${JSON.stringify(user("two"))}\n\n`;
    writeFileSync(path, raw);
    const log = PersistentSessionLog.open(dir, "session-f");
    expect(log.events()).toHaveLength(2);
    expect(log.tornTail).toBeNull();
    // No truncation: the padding is part of the valid region.
    expect(readFileSync(path, "utf8")).toBe(raw);
    log.close();
  });

  it("treats a whitespace-only line as unparsable (Rust `record.is_empty()`)", () => {
    const dir = tempDir();
    const path = join(dir, "session-g.jsonl");
    writeFileSync(path, `${JSON.stringify(user("one"))}\n   \n${JSON.stringify(user("two"))}\n`);
    const log = PersistentSessionLog.open(dir, "session-g");
    expect(log.events()).toHaveLength(1);
    expect(log.tornTail?.line).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(user("one"))}\n`);
    log.close();
  });

  it("repairs a missing final newline before appending", () => {
    const dir = tempDir();
    const path = join(dir, "session-h.jsonl");
    writeFileSync(path, JSON.stringify(user("one")));
    const log = PersistentSessionLog.open(dir, "session-h");
    log.append(user("two"));
    log.close();
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(user("one"));
  });

  it("clears events, truncates the file and resets the counter", () => {
    const dir = tempDir();
    const path = join(dir, "session-i.jsonl");
    const log = PersistentSessionLog.open(dir, "session-i");
    log.append(user("one"));
    expect(log.nextTurnId()).toBe("turn-0");
    log.clear();
    expect(log.events()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("");
    // Rust: clear() stores 0, so the emptied file and the counter stay in sync.
    expect(log.nextTurnId()).toBe("turn-0");
    log.append(user("two"));
    log.close();
    const reopened = PersistentSessionLog.open(dir, "session-i");
    expect(reopened.events()).toEqual([user("two")]);
    reopened.close();
  });

  it("sanitizes the session id into a file inside the directory", () => {
    expect(fileNameFor("CelesteaTeamAPI/scratch-1")).toBe("CelesteaTeamAPI_scratch-1.jsonl");
    expect(fileNameFor("")).toBe("session.jsonl");
    const dir = tempDir();
    expect(filePathFor(dir, "../../etc/passwd")).toBe(join(dir, ".._.._etc_passwd.jsonl"));
    const log = PersistentSessionLog.open(dir, "../../etc/passwd");
    log.append(user("safe"));
    log.close();
    expect(readFileSync(join(dir, ".._.._etc_passwd.jsonl"), "utf8")).toBe(serializeSessionJsonl([user("safe")]));
  });
});
