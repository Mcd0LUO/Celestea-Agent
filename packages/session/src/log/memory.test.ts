/** InMemorySessionLog — port of the Rust log.rs tests. */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { InMemorySessionLog } from "./memory.js";

const user = (text: string): SessionEvent => ({ type: "user_message", text });

describe("InMemorySessionLog", () => {
  it("is empty when created", () => {
    const log = new InMemorySessionLog();
    expect(log.events()).toEqual([]);
    expect(log.deriveMessages()).toEqual([]);
  });

  it("preserves append order and copies on read", () => {
    const log = new InMemorySessionLog();
    log.append(user("a"));
    log.append(user("b"));
    const snapshot = log.events();
    expect(snapshot.map((e) => (e.type === "user_message" ? e.text : ""))).toEqual(["a", "b"]);
    snapshot.push(user("c"));
    expect(log.events()).toHaveLength(2);
  });

  it("allocates monotonic turn ids and never reuses them after clear", () => {
    const log = new InMemorySessionLog();
    expect(log.nextTurnId()).toBe("turn-0");
    expect(log.nextTurnId()).toBe("turn-1");
    log.append(user("x"));
    log.clear();
    expect(log.events()).toEqual([]);
    expect(log.deriveMessages()).toEqual([]);
    expect(log.nextTurnId()).toBe("turn-2");
  });

  it("restores the counter after a replay (recovery hook)", () => {
    const log = new InMemorySessionLog();
    log.restoreTurnCounter(7);
    expect(log.peekTurnNumber()).toBe(7);
    expect(log.nextTurnId()).toBe("turn-7");
  });
});
