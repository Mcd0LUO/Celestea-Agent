/**
 * W855: tool-result retention — the budget is measured per result AND per step,
 * the omitted count is exact, the cut never breaks UTF-8, and a failed spill is
 * best-effort (the tool call stays successful with its full result inline).
 */

import { describe, expect, it } from "vitest";
import { assistantText, formatOmissionNotice, toolResultText, type Message, type ToolInput, type ToolOutput, type ToolRegistry } from "@celestea/core";
import {
  FakeToolRegistry,
  eventsOfType,
  harness,
  ScriptedLlm,
  toolCallMessage,
} from "./fakes.test-util.js";
import {
  RETENTION_SERVICE,
  cutPrefixCodePoints,
  cutSuffixCodePoints,
  newStepRetention,
  retainToolOutput,
  retentionText,
  type SpillRef,
  type ToolResultRetention,
} from "./retention.js";

function ref(locator = "/tmp/spill-1.txt"): SpillRef {
  return { locator, bytes: 10, retrievalHint: 'read_file path="' + locator + '"' };
}

function policy(
  spill?: ToolResultRetention["spill"],
  overrides: Partial<ToolResultRetention> = {},
): ToolResultRetention {
  return {
    singleResultBytes: 100,
    stepResultBytes: 1000,
    previewHeadBytes: 20,
    previewTailBytes: 10,
    spill: spill ?? (async () => ref()),
    ...overrides,
  };
}

function output(value: unknown, callId = "c1"): ToolOutput {
  return { call_id: callId, value, render: null, error: null, decision: null };
}

describe("W855 retention primitives", () => {
  it("cuts on code-point boundaries and reports the exact omitted byte count", () => {
    const text = "é".repeat(10); // 2 bytes each
    expect(cutPrefixCodePoints(text, 5)).toBe("éé");
    expect(Buffer.byteLength(cutPrefixCodePoints(text, 5), "utf8")).toBe(4);
    expect(cutSuffixCodePoints(text, 5)).toBe("éé");
    expect(Buffer.byteLength(cutSuffixCodePoints(text, 5), "utf8")).toBe(4);
    // never a broken lone surrogate / half code point
    expect(cutPrefixCodePoints("𐍈x", 3)).toBe("");
    expect(cutSuffixCodePoints("x𐍈", 3)).toBe("");
  });

  it("retentionText keeps a string value raw and JSON-encodes records", () => {
    expect(retentionText(output("hello"))).toBe("hello");
    expect(retentionText(output({ a: 1 }))).toBe('{"a":1}');
    expect(
      retentionText({ call_id: "c", value: "x", render: null, error: "boom", decision: null }),
    ).toBe("Error: boom");
  });

  it("the omission notice names the exact budget omission and the retrieval hint", () => {
    const notice = formatOmissionNotice({
      kind: "omitted",
      omitted_bytes: 1234,
      total_bytes: 9999,
      locator: "/s/spills/c1-1.txt",
      retrieval_hint: 'read_file path="/s/spills/c1-1.txt"',
      head_bytes: 4,
      tail_bytes: 2,
    });
    expect(notice).toContain("[omitted] 1234 of 9999 bytes");
    expect(notice).toContain("budget");
    expect(notice).toContain("/s/spills/c1-1.txt");
    expect(notice).toContain('read_file path="/s/spills/c1-1.txt"');
  });
});

describe("W855 retainToolOutput", () => {
  it("keeps a small result inline and debits the step budget", async () => {
    const step = newStepRetention();
    const small = output("hello");
    const out = await retainToolOutput(small, policy(), step);
    expect(out).toBe(small);
    expect(step.consumedBytes).toBe(5);
  });

  it("spills an over-threshold result; the model-visible value loses the full text", async () => {
    const big = "SECRET".repeat(40); // 240 bytes > 100
    const seen: string[] = [];
    const p = policy(async (text) => {
      seen.push(text);
      return ref();
    });
    const out = await retainToolOutput(output(big), p, newStepRetention());
    expect(seen).toEqual([big]);
    const value = String(out.value);
    expect(value).not.toContain(big);
    expect(value).toContain("/tmp/spill-1.txt");
    expect(value).toContain("read_file path=");
    expect(value).toContain("[omitted]");
    expect(out.render).toBe(value);
  });

  it("retains when the STEP cumulative budget is exceeded, even under the single threshold", async () => {
    const p = policy(undefined, { singleResultBytes: 1000, stepResultBytes: 150 });
    const step = newStepRetention();
    const first = await retainToolOutput(output("a".repeat(100), "c1"), p, step);
    expect(first.value).toBe("a".repeat(100));
    const second = await retainToolOutput(output("b".repeat(100), "c2"), p, step);
    expect(String(second.value)).toContain("[omitted]");
    expect(String(second.value)).toContain("/tmp/spill-1.txt");
  });

  it("keeps the ORIGINAL inline when the spill returns null; the call stays successful", async () => {
    const big = "x".repeat(500);
    const original = output(big);
    const out = await retainToolOutput(original, policy(async () => null), newStepRetention());
    expect(out).toBe(original);
    expect(out.error).toBeNull();
    expect(out.value).toBe(big);
  });

  it("keeps the ORIGINAL inline when the spill throws", async () => {
    const big = "x".repeat(500);
    const out = await retainToolOutput(
      output(big),
      policy(async () => {
        throw new Error("disk full");
      }),
      newStepRetention(),
    );
    expect(out.value).toBe(big);
    expect(out.error).toBeNull();
  });

  it("NEVER changes an object result's shape, even over the threshold", async () => {
    const big = { stdout: "x".repeat(500), stderr: "", exit_code: 0 };
    const spilled: string[] = [];
    const p = policy(async (text) => {
      spilled.push(text);
      return ref();
    });
    const step = newStepRetention();
    const original = output(big);
    const out = await retainToolOutput(original, p, step);
    expect(out).toBe(original);
    expect(out.value).toBe(big);
    expect(typeof out.value).toBe("object");
    expect(spilled).toHaveLength(0);
    // Non-string results still count toward the step budget.
    expect(step.consumedBytes).toBeGreaterThan(500);
  });

  it("NEVER rewrites an error result", async () => {
    const failed: ToolOutput = {
      call_id: "c1",
      value: null,
      render: null,
      error: "E".repeat(500),
      decision: null,
    };
    const out = await retainToolOutput(failed, policy(), newStepRetention());
    expect(out).toBe(failed);
    expect(out.error).toBe("E".repeat(500));
  });

  it("W855 #8b: skips a read tool's result entirely (no spill, no step debit)", async () => {
    const big = "READ".repeat(100); // 400 bytes > the 100-byte threshold
    let spills = 0;
    const p = policy(async () => {
      spills += 1;
      return ref();
    });
    const step = newStepRetention();
    const original = output(big);
    const out = await retainToolOutput(original, p, step, "read_file");
    expect(out).toBe(original);
    expect(out.value).toBe(big);
    expect(spills).toBe(0);
    expect(step.consumedBytes).toBe(0);
  });

  it("W855 #8b: the SAME result from a non-read tool is still retained (the contrast)", async () => {
    const big = "READ".repeat(100);
    const out = await retainToolOutput(output(big), policy(), newStepRetention(), "run_shell");
    expect(String(out.value)).toContain("[omitted]");
    expect(String(out.value)).toContain("/tmp/spill-1.txt");
  });
});

/** A registry whose per-call value is set by the test. */
class ValuesRegistry extends FakeToolRegistry {
  readonly values = new Map<string, unknown>();
  override async dispatch(input: ToolInput): Promise<ToolOutput> {
    return {
      call_id: input.call_id,
      value: this.values.get(input.call_id) ?? { ok: true },
      render: null,
      error: null,
      decision: { kind: "allow" },
    };
  }
}

describe("W855 loop integration", () => {
  function turn(registry: ToolRegistry) {
    return harness({
      llm: new ScriptedLlm([
        [{ kind: "done", message: toolCallMessage(["c1", "c2"]) }],
        [{ kind: "done", message: assistantText("done") }],
      ]),
      registry: registry as FakeToolRegistry,
    });
  }

  it("keeps the ORIGINAL in the log while the model request sees the bounded face (B6)", async () => {
    const full = "TOPSECRET".repeat(200); // 1800 bytes
    const registry = new ValuesRegistry();
    registry.values.set("c1", full);
    registry.values.set("c2", "ok");
    const h = turn(registry);
    h.ctx.provide(RETENTION_SERVICE, policy());
    const outcome = await h.run("go");
    expect(outcome).toBe("completed");
    const rows = eventsOfType(h.session, "tool_result");
    // (1) the session log stores the ORIGINAL value + the surface descriptor.
    expect(rows[0]?.value).toBe(full);
    expect(rows[0]?.surface?.kind).toBe("omitted");
    // (2) the model-visible face is the bounded form, never the full text.
    const modelText = toolResultText(rows[0]?.error ?? null, rows[0]?.value, rows[0]?.surface);
    expect(modelText).not.toContain(full);
    expect(modelText).toContain("/tmp/spill-1.txt");
    expect(modelText).toContain("[omitted]");
    expect(Buffer.byteLength(modelText, "utf8")).toBeLessThan(Buffer.byteLength(full, "utf8"));
  });

  it("without a retention policy the full text stays inline (the contrast that gives the case teeth)", async () => {
    const registry = new ValuesRegistry();
    registry.values.set("c1", "TOPSECRET".repeat(200));
    registry.values.set("c2", "ok");
    const h = turn(registry);
    await h.run("go");
    const rows = eventsOfType(h.session, "tool_result");
    expect(JSON.stringify(rows[0]?.value)).toContain("TOPSECRET");
  });

  it("W855 #8b: a read_file result stays full inline while a run_shell result is retained", async () => {
    const big = "TOPSECRET".repeat(200); // 1800 bytes
    const registry = new ValuesRegistry();
    registry.values.set("c1", big);
    registry.values.set("c2", big);
    const message: Message = {
      role: "assistant",
      content: [
        { type: "tool_call", content: { id: "c1", name: "read_file", args: {} } },
        { type: "tool_call", content: { id: "c2", name: "run_shell", args: {} } },
      ],
      tool_call_id: null,
    };
    const h = harness({
      llm: new ScriptedLlm([[{ kind: "done", message }], [{ kind: "done", message: assistantText("done") }]]),
      registry: registry as FakeToolRegistry,
    });
    h.ctx.provide(RETENTION_SERVICE, policy());
    expect(await h.run("go")).toBe("completed");
    const rows = eventsOfType(h.session, "tool_result");
    expect(rows[0]?.id).toBe("c1");
    expect(rows[0]?.value).toBe(big); // read_file: untouched, no surface
    expect(rows[0]?.surface).toBeUndefined();
    expect(rows[1]?.value).toBe(big); // run_shell: log keeps the ORIGINAL
    expect(rows[1]?.surface?.kind).toBe("omitted");
    expect(toolResultText(rows[1]?.error ?? null, rows[1]?.value, rows[1]?.surface)).toContain("[omitted]");
  });
});
