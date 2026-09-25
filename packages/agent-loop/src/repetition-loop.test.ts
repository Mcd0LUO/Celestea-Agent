/**
 * W1510 — loop-level wiring of the repetition guard, ported from the host plugin
 * `dsh-guard-repeat-output`.
 *
 * The detector's judgement is pinned in `repetition.test.ts` and the pure halves
 * of the port in `repetition-recovery.test.ts`. What matters HERE is the loop
 * contract:
 *
 *   - a DeepSeek stream that collapses is DISCARDED — its degenerate text never
 *     reaches the log — and the call is RE-ISSUED on a perturbed route, so the
 *     turn continues instead of dying;
 *   - when the retry budget is spent the guard stops discarding whole attempts
 *     and truncates at the onset, keeping the healthy prefix;
 *   - a NON-DeepSeek model streaming the very same text is completely untouched;
 *   - a discarded attempt does not consume the step budget.
 */

import { describe, expect, it } from "vitest";
import { assistantText, type Llm, type LlmStream, type ModelRequest, type StreamEvent } from "@celestea/core";
import { isPerturbable, withRepetitionPerturbation } from "./perturbation.js";
import { DEEPSEEK_REPETITION_THRESHOLDS } from "./repetition.js";
import { eventsOfType, FakeSessionLog, FakeToolRegistry, harness, lastOutcome } from "./fakes.test-util.js";

/** The real collapse shape that motivated this work. */
const COLLAPSE = "OK. Let me write. Let me go. ".repeat(200);

/** A healthy long answer, used as the second attempt's script. */
const HEALTHY = Array.from(
  { length: 60 },
  (_, i) => `Point ${i} records a distinct, verified observation about module ${i} and its exit code.`,
).join(" ");

/** Stream one text event per delta, then a done frame. */
function textStream(deltas: readonly string[], message: string | null = null): LlmStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      for (const delta of deltas) yield { kind: "text", text: delta };
      if (message !== null) yield { kind: "done", message: assistantText(message) };
    },
  };
}

/** Stream thinking deltas only, then a done frame. */
function thinkingStream(deltas: readonly string[], message: string | null = null): LlmStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      for (const delta of deltas) yield { kind: "thinking", text: delta };
      if (message !== null) yield { kind: "done", message: assistantText(message) };
    },
  };
}

/** Split text into `size`-character deltas, the way a provider would stream it. */
function deltas(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** An Llm that serves one script per call and records every request. */
class ScriptedTextLlm implements Llm {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly scripts: ReadonlyArray<LlmStream>) {}

  async generate(req: ModelRequest): Promise<LlmStream> {
    this.requests.push(req);
    const script = this.scripts[this.index] ?? textStream([], "fallback");
    this.index += 1;
    return script;
  }
}

describe("repetition — discard and re-issue (the ported primary path)", () => {
  it("discards the collapsed attempt and answers from the retry", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    const h = harness({ llm });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    // One call for the collapsed attempt, one for the re-issue.
    expect(llm.requests).toHaveLength(2);
    // The degenerate attempt never became an assistant message.
    const replies = eventsOfType(h.session, "assistant_message");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe(HEALTHY);
  });

  it("the re-issued request is built from the SAME context — the collapse is absent", async () => {
    // This is what "as if it never happened" means mechanically: the second
    // request carries exactly the same messages as the first, because the
    // discarded attempt appended nothing.
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    const h = harness({ llm });

    await h.run();

    expect(llm.requests[1]?.messages).toEqual(llm.requests[0]?.messages);
    for (const message of llm.requests[1]?.messages ?? []) {
      expect(JSON.stringify(message)).not.toContain("Let me go. Let me go.");
    }
  });

  it("does not debit the step budget for a discarded attempt", async () => {
    // With max_steps = 1 a collapsing model would otherwise end the turn as
    // step_limit after producing nothing at all.
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    const h = harness({ llm, config: { max_steps: 1 } });

    expect(await h.run()).toBe("completed");
    expect(llm.requests).toHaveLength(2);
  });

  it("discards a degenerate REASONING burst instead of persisting it", async () => {
    // Without the discard, the guard would fire and the loop would then flush the
    // very burst it just convicted — writing the 1.4 MB row it exists to prevent.
    const degenerateReasoning = "Let me produce the report. ".repeat(200);
    const llm = new ScriptedTextLlm([
      thinkingStream(deltas(degenerateReasoning), "here is the answer"),
      textStream(deltas(HEALTHY), HEALTHY),
    ]);
    const h = harness({ llm });

    await h.run();

    expect(eventsOfType(h.session, "thinking_delta")).toHaveLength(0);
  });

  it("still persists healthy reasoning on a normal turn", async () => {
    const healthy = Array.from({ length: 30 }, (_, i) => `Reasoning step ${i} checks a distinct premise. `).join("");
    const llm = new ScriptedTextLlm([thinkingStream(deltas(healthy), "the answer")]);
    const h = harness({ llm });

    expect(await h.run()).toBe("completed");
    expect(eventsOfType(h.session, "thinking_delta").length).toBeGreaterThan(0);
  });

  it("a provider failure on the re-issue is still reported as the turn's error", async () => {
    class FailingSecondLlm implements Llm {
      private call = 0;
      async generate(): Promise<LlmStream> {
        this.call += 1;
        if (this.call === 1) return textStream(deltas(COLLAPSE));
        throw new Error("provider exploded on the re-issue");
      }
    }
    const h = harness({ llm: new FailingSecondLlm() });

    const outcome = await h.run();

    expect(typeof outcome).toBe("object");
    expect(lastOutcome(h.session)).toEqual(outcome);
  });
});

describe("repetition — budget exhausted, truncate at the onset", () => {
  /** Every attempt collapses: the retry budget runs out and the cut arm runs. */
  function alwaysCollapsing(): ScriptedTextLlm {
    return new ScriptedTextLlm([
      textStream(deltas(COLLAPSE)),
      textStream(deltas(COLLAPSE)),
      textStream(deltas(COLLAPSE)),
      textStream(deltas("The conclusion is that the shard reindex succeeded.")),
    ]);
  }

  it("spends the retry budget first, then stops discarding", async () => {
    const llm = alwaysCollapsing();
    const h = harness({ llm });

    expect(await h.run()).toBe("interrupted");
    // 1 initial + 2 retries + 1 wrap-up round trip.
    expect(llm.requests).toHaveLength(4);
  });

  it("keeps a healthy prefix instead of throwing the whole attempt away", async () => {
    // The prefix is real work: the truncation arm must persist it, which is what
    // separates this arm from the discard arm.
    const prefix = Array.from({ length: 40 }, (_, i) => `Finding ${i} is distinct and verified.`).join(" ");
    const llm = new ScriptedTextLlm([
      textStream(deltas(prefix + " " + COLLAPSE)),
      textStream(deltas(prefix + " " + COLLAPSE)),
      textStream(deltas(prefix + " " + COLLAPSE)),
      textStream(deltas("Conclusion stated once.")),
    ]);
    const h = harness({ llm });

    await h.run();

    const replies = eventsOfType(h.session, "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    const joined = replies.map((row) => row.text).join("\n");
    expect(joined).toContain("Finding 0 is distinct and verified.");
    // The degeneration is dropped, measured by how much of it survived:
    // asserting on a single substring is too weak here, because the repeated
    // unit is the whole phrase and "Let me go. Let me go." never occurs in it.
    const survivors = joined.split("Let me go.").length - 1;
    expect(survivors).toBeLessThan(4);
    expect(joined.length).toBeLessThan(prefix.length + 400);
  });

  it("asks the model to wrap up rather than failing the turn", async () => {
    const llm = alwaysCollapsing();
    const h = harness({ llm });

    await h.run();

    const injected = eventsOfType(h.session, "user_message").filter((row) => row.origin === "steering");
    expect(injected).toHaveLength(1);
    expect(injected[0]?.text).toContain("[repetition-guard]");
    expect(injected[0]?.text).toContain("state the conclusion or current state ONCE");
  });

  it("a zero retry budget truncates on the very first conviction", async () => {
    const llm = new ScriptedTextLlm([
      textStream(deltas(COLLAPSE)),
      textStream(deltas("Conclusion stated once.")),
    ]);
    const h = harness({ llm, bindings: { repetitionRetries: 0 } });

    expect(await h.run()).toBe("interrupted");
    // No re-issue: the first conviction already truncates.
    expect(llm.requests).toHaveLength(2);
  });

  it("a broken seam in the wrap-up still leaves the turn interrupted", async () => {
    const session = new FakeSessionLog();
    const original = session.append.bind(session);
    session.append = (event) => {
      if (event.type === "user_message" && event.origin === "steering") throw new Error("log is read-only");
      original(event);
    };
    const h = harness({ llm: alwaysCollapsing(), session });

    const outcome = await h.run();

    expect(outcome).toBe("interrupted");
    expect(eventsOfType(session, "turn_end")[0]?.outcome).toBe("interrupted");
  });
});

describe("repetition — scope and switches", () => {
  it("a NON-DeepSeek model streaming the same collapse is completely untouched", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE, 24), COLLAPSE)]);
    const h = harness({ llm, config: { model: "gpt-4o" } });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(llm.requests).toHaveLength(1);
    expect(eventsOfType(h.session, "assistant_message")[0]?.text).toBe(COLLAPSE);
  });

  it("`repetition: false` disables detection even for a DeepSeek model", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE, 24), COLLAPSE)]);
    const h = harness({ llm, bindings: { repetition: false } });

    expect(await h.run()).toBe("completed");
    expect(llm.requests).toHaveLength(1);
  });

  it("an explicit threshold override is honoured", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE, 24), COLLAPSE)]);
    const h = harness({
      llm,
      bindings: { repetition: { ...DEEPSEEK_REPETITION_THRESHOLDS, phraseRun: 100_000, phraseTopCount: 100_000 } },
    });

    expect(await h.run()).toBe("completed");
    expect(llm.requests).toHaveLength(1);
  });

  it("a short DeepSeek reply is never judged (below the window floor)", async () => {
    const short = "OK. Let me write. ".repeat(60);
    const llm = new ScriptedTextLlm([textStream(deltas(short, 24), short)]);
    const h = harness({ llm });

    expect(await h.run()).toBe("completed");
    expect(llm.requests).toHaveLength(1);
  });
});

describe("repetition — the perturbation reaches the route", () => {
  it("steps the reasoning effort down one rung for the re-issued attempt", async () => {
    const applied: string[] = [];
    const inner = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    const llm = withRepetitionPerturbation(inner, {
      currentEffort: "max",
      apply: (effort) => {
        applied.push(effort);
        return inner;
      },
    });
    const h = harness({ llm });

    await h.run();

    expect(applied).toEqual(["high"]);
  });

  it("a plain Llm is not perturbable, so the loop degrades instead of crashing", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    expect(isPerturbable(llm)).toBe(false);
    const h = harness({ llm });

    // The retry still happens; only the route is unchanged.
    expect(await h.run()).toBe("completed");
    expect(llm.requests).toHaveLength(2);
  });
});

describe("repetition — invariants preserved", () => {
  it("still writes exactly one turn_end", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    const h = harness({ llm });

    await h.run();

    expect(eventsOfType(h.session, "turn_end")).toHaveLength(1);
  });

  it("the tool registry is never touched by a collapsed attempt", async () => {
    const llm = new ScriptedTextLlm([textStream(deltas(COLLAPSE)), textStream(deltas(HEALTHY), HEALTHY)]);
    const registry = new FakeToolRegistry();
    const h = harness({ llm, registry });

    await h.run();

    expect(registry.order).toEqual([]);
    expect(eventsOfType(h.session, "tool_call")).toHaveLength(0);
  });
});
