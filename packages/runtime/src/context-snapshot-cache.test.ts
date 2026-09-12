/**
 * W762: the `Runtime.contextSnapshot()` memoization.
 *
 * The cache exists because the statusline reads the assembly on every 2s tick
 * and the context viewer on every refresh, while a session log only changes
 * when the engine appends to it. What these tests pin is the CONTRACT of that
 * cache, not the assembly itself (which is the loop's, unchanged):
 *   - an unchanged log assembles ONCE and hands back the same object;
 *   - an append invalidates it (a new object, with the new event in it);
 *   - a rebind invalidates it even when the new log has the same event COUNT
 *     and the very same last-event REFERENCE — only the log identity differs;
 *   - two generations over the same log never share a cache (per-generation
 *     field, never a module singleton);
 *   - `release()` drops it.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_SERVICE,
  SESSION_LOG_SERVICE,
  definePlugin,
  memoryEventStore,
  projectingSessionLog,
  type AgentLoop,
  type Context,
  type ModelRequest,
  type SessionEvent,
  type SessionLog,
} from "@celestea/core";
import { compose } from "./compose.js";
import { createSessionBinding } from "./session-binding.js";
import type { Profile } from "./profile.js";
import type { Runtime } from "./runtime.js";

function benchProfile(): Profile {
  return {
    model: "deepseek-chat",
    base_url: "http://127.0.0.1:3001/v1",
    api_key_env: "DEEPSEEK_API_KEY",
    api_key_file: null,
    max_steps: 4,
    max_parallel_tool_calls: 2,
    reasoning_effort: null,
    max_output_tokens: null,
    context_window_tokens: 65_536,
    system_prompt: "You are celestea.",
    request_format: "chat_completions",
    temperature: null,
  };
}

/** A loop double that COUNTS its `contextSnapshot()` calls (the thing under test is the cache). */
class CountingLoop implements AgentLoop {
  calls = 0;

  async runTurn(): Promise<void> {
    // No turn is driven here: the cache only cares about the snapshot path.
  }

  contextSnapshot(ctx: Context): ModelRequest {
    this.calls += 1;
    const log = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
    return {
      model: "double",
      system: "sys",
      messages: log?.deriveMessages() ?? [],
      tools: [],
      max_tokens: null,
      temperature: null,
    };
  }
}

/** A real projecting log over a memory store, seeded with raw SessionEvents. */
function memoryLog(events: readonly SessionEvent[] = []): SessionLog {
  const log = projectingSessionLog(memoryEventStore());
  for (const event of events) log.append(event);
  return log;
}

/** A generation over `open()`'s log, with the counting loop mounted. */
/** One `user_message` row (the log stores events, not messages). */
function userRow(text: string): SessionEvent {
  return { type: "user_message", text };
}

function runtimeWith(loop: CountingLoop, open: () => SessionLog, sessionId = "bench/session"): Runtime {
  return compose({
    profile: benchProfile(),
    sessionBinding: createSessionBinding({ sessionId, open }),
    plugins: [definePlugin("test.loop", (ctx) => ctx.provide(AGENT_LOOP_SERVICE, loop))],
    workers: false,
    watchdog: false,
  });
}

describe("Runtime.contextSnapshot() memoization (W762)", () => {
  it("assembles once while the log is unchanged and hands back the same object", () => {
    const loop = new CountingLoop();
    const log = memoryLog([userRow("hello")]);
    const runtime = runtimeWith(loop, () => log);

    const first = runtime.contextSnapshot();
    const second = runtime.contextSnapshot();

    expect(loop.calls).toBe(1);
    expect(second).toBe(first);
    expect(first?.messages).toHaveLength(1);
  });

  it("re-assembles after an append and sees the new event", () => {
    const loop = new CountingLoop();
    const log = memoryLog([userRow("hello")]);
    const runtime = runtimeWith(loop, () => log);

    const first = runtime.contextSnapshot();
    log.append(userRow("again"));

    const second = runtime.contextSnapshot();

    expect(loop.calls).toBe(2);
    expect(second).not.toBe(first);
    expect(second?.messages).toHaveLength(2);
  });

  it("never serves an assembly across a rebind with the same count and the same last event", () => {
    const loop = new CountingLoop();
    const shared = userRow("identical row");
    const firstLog = memoryLog([shared]);
    const secondLog = memoryLog([shared]); // same length, SAME event object
    const runtime = runtimeWith(loop, () => firstLog);

    runtime.contextSnapshot();
    runtime.rebind(createSessionBinding({ sessionId: "bench/other", open: () => secondLog }));
    runtime.contextSnapshot();

    expect(loop.calls).toBe(2);
    expect(runtime.session).toBe(secondLog);
  });

  it("keeps one cache per generation, never a module singleton", () => {
    const loopA = new CountingLoop();
    const loopB = new CountingLoop();
    const log = memoryLog([userRow("hello")]);

    const a = runtimeWith(loopA, () => log);
    const b = runtimeWith(loopB, () => log);
    a.contextSnapshot();
    b.contextSnapshot();
    a.contextSnapshot();
    b.contextSnapshot();

    expect([loopA.calls, loopB.calls]).toEqual([1, 1]);
  });

  it("drops the cache on release and refuses further reads", () => {
    const loop = new CountingLoop();
    const log = memoryLog([userRow("hello")]);
    const runtime = runtimeWith(loop, () => log);

    runtime.contextSnapshot();
    runtime.release();

    expect(() => runtime.contextSnapshot()).toThrow();
  });
});
