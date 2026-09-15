/**
 * W744 (audit D3) — the SSE payload contract is asserted on the PRODUCTION
 * mapper, not on the agent-loop copy.
 *
 * Production publishes `@celestea/runtime`'s `loopEventToFrame`: `compose()`
 * uses it whenever the host passes no `frameMapper` (compose.ts), and no host
 * does. The previous assertions lived in `packages/agent-loop/src/events.test.ts`
 * against `loopEventToSse` — a copy — so a drift in the production file was
 * invisible.
 *
 * Every check below is driven by `contracts/sse-events.json`: key sets and the
 * per-key type descriptors, so a rename, a dropped key or a wrong type fails
 * with the event name and the key in the message.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadSse, type LoopEvent } from "@celestea/core";
import { questionFrame } from "@celestea/runtime";
import { loopEventToSse } from "@celestea/agent-loop";
import { createStudioBus } from "@celestea/studio";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { productionMapper, runProductionTurn } from "./lib/engine-corpus.js";
import { validateSchema } from "./lib/json-schema.js";
import { checkPayload, describeFrameViolations, descriptorTable, payloadKeyTable } from "./lib/sse-parity.js";

const SSE = loadSse();
/** The 6 contract events a `LoopEvent` can produce (status/compact are host-emitted). */
const LOOP_EVENTS: Array<{ kind: LoopEvent["kind"]; contractName: string }> = [
  { kind: "text", contractName: "text" },
  { kind: "thinking", contractName: "thinking" },
  { kind: "tool_call", contractName: "tool" },
  { kind: "tool_result", contractName: "tool_result" },
  { kind: "turn_end", contractName: "turn_end" },
  { kind: "done", contractName: "done" },
];
/** One representative LoopEvent per kind (both branches where a union exists). */
const SAMPLES: LoopEvent[] = [
  { kind: "text", delta: "hi" },
  { kind: "thinking", delta: "hmm" },
  { kind: "tool_call", id: "c1", name: "read_file", args: { path: "x" } },
  { kind: "tool_result", callId: "c1", ok: true, value: { a: 1 }, render: null, error: null, decision: "allow" },
  { kind: "tool_result", callId: "c2", ok: false, value: null, render: null, error: "boom", decision: "deny" },
  { kind: "tool_result", callId: "c3", ok: true, value: "v", render: null, error: null, decision: null },
  { kind: "turn_end", outcome: "completed" },
  { kind: "turn_end", outcome: "cancelled" },
  { kind: "turn_end", outcome: "step_limit" },
  { kind: "turn_end", outcome: "interrupted" },
  { kind: "turn_end", outcome: { error: { kind: "generate", message: "boom" } } },
  { kind: "done", text: "x", tool_calls: [{ id: "c1", name: "t", args: {} }] },
];

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("W744 · SSE payloads: the production runtime/frames.ts vs contracts/sse-events.json", () => {
  it("maps every LoopEvent kind onto its contract event name (production mapper)", () => {
    for (const row of LOOP_EVENTS) {
      const sample = SAMPLES.find((s) => s.kind === row.kind);
      expect(sample, `no sample for LoopEvent kind '${row.kind}'`).toBeDefined();
      const frame = productionMapper(sample!);
      expect(frame.event, `LoopEvent '${row.kind}' must publish the contract event '${row.contractName}'`).toBe(row.contractName);
    }
  });

  it("checks every sample payload against the frozen key set and type table", () => {
    const failures: string[] = [];
    for (const sample of SAMPLES) {
      const frame = productionMapper(sample);
      for (const violation of checkPayload(SSE, frame.event, frame.payload)) {
        failures.push(`${violation.message} [LoopEvent kind '${sample.kind}', runtime/frames.ts]`);
      }
    }
    expect(describeFrameViolations(failures.map((f) => ({ event: "", key: null, message: f })))).toBe("");
  });

  it("the runtime's default mapper IS loopEventToFrame (compose with no frameMapper override)", async () => {
    const auto = await runProductionTurn("default mapper");
    const explicit = await runProductionTurn("default mapper", { mapper: productionMapper });
    expect(auto.frames.map((f) => f.event)).toEqual(explicit.frames.map((f) => f.event));
    expect(JSON.stringify(auto.frames)).toBe(JSON.stringify(explicit.frames));
  });

  it("checks every frame of a live engine turn (the frames GET /api/events publishes)", async () => {
    const turn = await runProductionTurn("live frames");
    expect([...new Set(turn.frames.map((f) => f.event))].sort()).toEqual(["done", "text", "thinking", "tool", "tool_result", "turn_end"]);
    const failures: string[] = [];
    for (const frame of turn.frames) {
      for (const violation of checkPayload(SSE, frame.event, frame.payload)) failures.push(`${violation.message} [live turn, runtime/frames.ts]`);
    }
    expect(failures.join("\n")).toBe("");
  });

  it("keeps the agent-loop copy in lockstep with the production mapper", () => {
    for (const sample of SAMPLES) {
      expect(loopEventToSse(sample), `agent-loop's copy drifted from runtime/frames.ts on '${sample.kind}'`).toEqual(productionMapper(sample));
    }
  });

  /**
   * W785 (E §4.4 D8): the fallback frame is a `status` frame — the event NAME set
   * is unchanged (still 9) and every field it adds is declared. This validates the
   * PRODUCTION payload shape (`real-runtime-adapter.emitFallback`) against the
   * frozen table, so widening `phase` or adding a key without touching the
   * contract fails here instead of drifting silently.
   */
  it("accepts the W785 fallback status frame without touching the event-name set", () => {
    const payload = {
      phase: "fallback",
      statusline: {},
      effective_model: "model-b",
      from: "primary",
      to: "backup",
      reason: "http_503",
      attempt: 1,
    };
    expect(describeFrameViolations(checkPayload(SSE, "status", payload))).toBe("");
    // The value that was added is a payload VALUE; the names are frozen at 9.
    expect(SSE.events.map((e) => e.name)).toHaveLength(9);
    expect(SSE.count).toBe(9);
  });

  it("binds all 9 contract events to a named producer (none unbound, none invented)", () => {
    const loopNames = LOOP_EVENTS.map((r) => r.contractName);
    // W783: `question` is host-emitted by the user-questions service while the
    // turn is parked — a LoopEvent can never produce it, so it is named here.
    const hostNames = ["status", "compact", "question"];
    expect([...loopNames, ...hostNames].sort()).toEqual(SSE.events.map((e) => e.name).sort());
    expect(payloadKeyTable(SSE, "status").extensions.length).toBeGreaterThan(0);
    // W783: `question` is host-emitted but a first-class contract event, so its
    // payload is declared in the events table itself (not in payloadExtensions).
    expect(payloadKeyTable(SSE, "question").frozen).toEqual(["id", "questions", "expires_at", "timeout_ms", "session"]);
  });

  /**
   * W783: `question` has no LoopEvent producer — a parked tool call emits no
   * loop event — so the check above only proves it is DECLARED. Here the
   * PRODUCTION builder (`packages/runtime/src/frames.ts`) is executed and its
   * frame is validated against the frozen table, which is what stops the payload
   * from drifting the moment somebody edits it.
   */
  it("checks the production question frame against the contract", () => {
    const frame = questionFrame({
      session: "sample-ws/s1",
      id: "q-7",
      questions: [{ id: "mode", question: "选哪个？", options: [{ label: "A（推荐）" }, { label: "B" }] }],
      expiresAt: 1_700_000_300_000,
      timeoutMs: 300_000,
    });
    expect(frame.event).toBe("question");
    expect(describeFrameViolations(checkPayload(SSE, frame.event, frame.payload))).toBe("");
    // Every declared key must actually be produced (a key that is never written
    // is a contract promise the host does not keep).
    expect(Object.keys(frame.payload).sort()).toEqual(Object.keys(descriptorTable(SSE, "question")).sort());
  });

  it("checks the host-emitted compact payload (production endpoint) against the contract", async () => {
    const h = makeHarness({ session: { name: "s1", log: `${JSON.stringify({ type: "turn_start", id: "turn-0" })}\n` } });
    harnesses.push(h);
    const sub = h.studio.services.bus.subscribe();
    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fs1/compact", jsonRequest("POST"));
    expect(res.status).toBe(200);
    const frame = await sub.next();
    sub.close();
    expect(frame?.event).toBe("compact");
    const payload = payloadOf(frame);
    expect(describeFrameViolations(checkPayload(SSE, "compact", payload))).toBe("");
    expect(Object.keys(payload).sort()).toEqual(Object.keys(SSE.events.find((e) => e.name === "compact")?.payload ?? {}).sort());
  });

  it("checks the production lagged status frame (bus overflow) against the contract", async () => {
    const bus = createStudioBus({ capacity: 1 });
    const sub = bus.subscribe();
    bus.emit("text", 1, { delta: "a" }, "ws/a");
    bus.emit("text", 1, { delta: "b" }, "ws/a"); // overflows the session bucket
    // The overflow drops the session's WHOLE bucket (no replay) and hands the
    // client one lagged status, which is the next - and only - frame.
    const lagged = await sub.next();
    sub.close();
    expect(lagged?.event).toBe("status");
    const payload = payloadOf(lagged);
    expect(describeFrameViolations(checkPayload(SSE, "status", payload))).toBe("");
    expect(payload["phase"]).toBe(SSE.lagged.payload["phase"]);
    expect(payload["hint"]).toBe(SSE.lagged.payload["hint"]);
    expect(payload["dropped"]).toBe(2);
  });

  it("validates a real envelope against envelopeSchema widened by the declared W513 keys", () => {
    const bus = createStudioBus();
    const frame = bus.emit("text", 3, { delta: "x" }, "ws/s1");
    expect(validateSchema(widenedEnvelopeSchema(), frame.envelope)).toEqual([]);
    // ...and the widened schema still rejects an undeclared envelope key.
    const drifted = { ...frame.envelope, extra: 1 };
    expect(validateSchema(widenedEnvelopeSchema(), drifted).map((v) => v.path)).toContain("$.extra");
  });

  it("REJECTS a drifted mapper, naming the event and the key (the check has teeth)", () => {
    const toolResult = SAMPLES.filter((s) => s.kind === "tool_result");
    const renamed = checkPayload(SSE, "tool_result", { id: "c1", ok: true, value: null, render: null, error: null, verdict: "allow" });
    const text = describeFrameViolations(renamed);
    expect(text).toContain("missing contract payload key 'decision'");
    expect(text).toContain("verdict");
    expect(toolResult.length).toBeGreaterThan(0);

    const wrongType = checkPayload(SSE, "tool_result", { id: "c1", ok: "yes", value: null, render: null, error: null, decision: "maybe" });
    const typeText = describeFrameViolations(wrongType);
    expect(typeText).toContain("payload key 'ok'");
    expect(typeText).toContain("expected boolean");
    expect(typeText).toContain("payload key 'decision'");
    expect(typeText).toContain("'allow'|'deny'|'ask'|null");

    const droppedKey = checkPayload(SSE, "done", { text: "x" });
    expect(describeFrameViolations(droppedKey)).toContain("missing contract payload key 'tool_calls'");
  });
});

/** The frame payload as a record (`SseEnvelope.payload` is typed `unknown`). */
function payloadOf(frame: { envelope: { payload: unknown } } | null | undefined): Record<string, unknown> {
  const payload = frame?.envelope.payload;
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/** `transport.envelopeSchema` widened by the declared W513 extension keys. */
function widenedEnvelopeSchema(): Record<string, unknown> {
  const transport = SSE.transport as unknown as Record<string, unknown>;
  const base = transport["envelopeSchema"] as Record<string, unknown>;
  const extensions = (transport["envelopeExtensions"] ?? {}) as Record<string, unknown>;
  const properties = { ...(base["properties"] as Record<string, unknown>) };
  for (const [key, schema] of Object.entries(extensions)) {
    if (key !== "note" && schema !== null && typeof schema === "object") properties[key] = schema;
  }
  return { ...base, properties };
}
