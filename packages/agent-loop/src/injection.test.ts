/**
 * W513 mid-turn injection — the loop's step boundary.
 *
 * The rule under test: whatever the session inbox hands over while a turn is
 * RUNNING is appended to the session log as a `user_message` row right before
 * the NEXT model call. The turn is not interrupted and no second turn starts —
 * the injected text simply becomes part of this turn's model-visible history.
 */

import { describe, expect, it } from "vitest";
import {
  assistantText,
  userMessage,
  type Llm,
  type LlmStream,
  type Message,
  type ModelRequest,
  type PendingInjection,
  type SessionEvent,
  type StreamEvent,
} from "@celestea/core";
import { FakeSessionLog, harness, scriptedStream, toolCallMessage } from "./fakes.test-util.js";

/** One `StreamEvent::Done(message)`. */
function done(message: Message): StreamEvent {
  return { kind: "done", message };
}

/** A log whose projection follows the recorded events (the real log's rule). */
class ProjectingLog extends FakeSessionLog {
  override deriveMessages(): Message[] {
    return this.events().flatMap((e) => (e.type === "user_message" ? [userMessage(e.text)] : []));
  }
}

/** A FIFO inbox the test can push into at any moment. */
function inbox(): { push: (text: string, from?: string) => void; source: { drain: () => readonly PendingInjection[] } } {
  const queue: PendingInjection[] = [];
  return {
    push(text: string, from = ""): void {
      queue.push({ text, from });
    },
    source: { drain: (): readonly PendingInjection[] => queue.splice(0, queue.length) },
  };
}

/**
 * An LLM that injects while serving its FIRST call: the message is therefore
 * already queued when the loop comes back for step 2.
 */
function injectingLlm(requests: ModelRequest[], inject: () => void): Llm {
  let calls = 0;
  return {
    generate(req: ModelRequest): Promise<LlmStream> {
      requests.push(req);
      calls += 1;
      if (calls === 1) {
        inject();
        return Promise.resolve(scriptedStream([done(toolCallMessage(["c1"]))]));
      }
      return Promise.resolve(scriptedStream([done(assistantText("done"))]));
    },
  };
}

function userTexts(events: readonly SessionEvent[]): string[] {
  return events.filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
}

describe("mid-turn injection at the step boundary", () => {
  it("appends the interjection to the SAME turn, before the next model call", async () => {
    const box = inbox();
    const requests: ModelRequest[] = [];
    const h = harness({
      llm: injectingLlm(requests, () => box.push("插话：改用 B 方案")),
      bindings: { injections: box.source },
      session: new ProjectingLog(),
    });

    expect(await h.run("先看一下目录")).toBe("completed");

    const events = h.session.events();
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(userTexts(events)).toEqual(["先看一下目录", "插话：改用 B 方案"]);
    // The injected row sits AFTER the tool result and BEFORE the turn end.
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("tool_result")).toBeLessThan(kinds.lastIndexOf("user_message"));
    expect(kinds.lastIndexOf("user_message")).toBeLessThan(kinds.lastIndexOf("turn_end"));

    // ...and the SECOND model call is the one that sees it.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual([userMessage("先看一下目录")]);
    expect(requests[1]?.messages).toEqual([userMessage("先看一下目录"), userMessage("插话：改用 B 方案")]);
  });

  it("attributes a worker receipt and keeps FIFO order across several injections", async () => {
    const box = inbox();
    const requests: ModelRequest[] = [];
    const h = harness({
      llm: injectingLlm(requests, () => {
        box.push("第一次插话");
        box.push("WORKER_W9_DONE 报告 results/W9-x.md", "session-9");
      }),
      bindings: { injections: box.source },
      session: new ProjectingLog(),
    });

    await h.run("go");

    expect(userTexts(h.session.events())).toEqual(["go", "第一次插话", "[from session-9] WORKER_W9_DONE 报告 results/W9-x.md"]);
  });

  it("drains nothing and makes no extra call when the inbox stays empty", async () => {
    const box = inbox();
    const requests: ModelRequest[] = [];
    const h = harness({
      llm: injectingLlm(requests, () => undefined),
      bindings: { injections: box.source },
      session: new ProjectingLog(),
    });

    await h.run("go");

    expect(userTexts(h.session.events())).toEqual(["go"]);
    expect(requests).toHaveLength(2);
  });
});
