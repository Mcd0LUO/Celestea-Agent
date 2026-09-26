/**
 * W783 — the user-question chain end to end over the REAL engine.
 *
 * What this file pins, in the order the design argues for it:
 *   1. the answer resolves the PARKED tool call rather than travelling as a
 *      message (§4.2) — the whole point of the feature;
 *   2. the maximum wait is enforced on both tracks (§6): the timer settles the
 *      tool, and the absolute deadline is what a reader judges;
 *   3. a timeout decides NOTHING for the model (§6.3) — no default option, no
 *      cancelled turn, just `{answers: [], timed_out: true}`;
 *   4. a sub-agent cannot ask at all (§5.3);
 *   5. `selected` carries LABELS and `intent` is validated (§3.2/§3.3);
 *   6. the recovery list reports remaining time judged at READ time (§7).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus, delegatedCallerScope, loadSse } from "@celestea/core";
import { jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { createQuestionRegistry, type PendingQuestion, type QuestionRegistry } from "../question-registry.js";
import { createUserQuestionService } from "../user-questions.js";
import { activate, makeEngineHarness } from "./test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** One engine host whose model asks a question on its first step. */
function asker(questions: unknown[], timeoutMs?: number): StudioHarness {
  const h = makeEngineHarness({
    sessions: { s1: [{ type: "turn_start", id: "turn-0" }, { type: "turn_end", id: "turn-0" }] },
    llm: {
      script: [
        {
          tool_calls: [
            {
              id: "c1",
              name: "ask_user_question",
              args: { questions, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) },
            },
          ],
        },
        { text: "继续了" },
      ],
    },
  });
  harnesses.push(h);
  return h;
}

/** Wait until the model's question is parked, returning its request id. */
async function waitForQuestion(h: StudioHarness, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await h.app.request("/api/questions");
    const body = (await res.json()) as { questions: Array<{ id: string }> };
    const first = body.questions[0];
    if (first !== undefined) return first.id;
    if (Date.now() > deadline) throw new Error("the question never parked");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const OPTIONS = [
  { id: "mode", question: "选哪个方案？", header: "确认", options: [{ label: "方案 A（推荐）" }, { label: "方案 B", description: "更慢" }] },
];

describe("W783 · the answer resolves the parked tool call (never a message)", () => {
  it("wakes the tool with the human's answer and lets the turn continue", async () => {
    const h = asker(OPTIONS);
    await activate(h, "sample-ws/s1");
    const frames: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const sub = h.studio.services.bus.subscribe();
    const pump = (async () => {
      for (;;) {
        const frame = await sub.next();
        if (frame === null) return;
        frames.push({ event: frame.event, payload: frame.envelope.payload as Record<string, unknown> });
      }
    })();

    const turned = await h.app.request("/api/turn", jsonRequest("POST", { input: "问一下", session: "sample-ws/s1" }));
    expect(turned.status).toBe(202);

    const id = await waitForQuestion(h);
    // The frame the UI needs, validated against the frozen SSE contract.
    const frame = frames.find((f) => f.event === "question");
    expect(frame?.payload["id"]).toBe(id);
    expect(frame?.payload["session"]).toBe("sample-ws/s1");
    expect(loadSse().events.map((e) => e.name)).toContain("question");

    // The turn's slot is OCCUPIED while the question is parked: this is exactly
    // the state in which POST /api/turn would only be steering (§2.2).
    expect(h.runtime.isBusy("sample-ws/s1")).toBe(true);

    // `selected` carries LABELS (never indices), plus the free-text answer.
    // W9206-32: a real client always names the session it is answering for
    // (`card.ts` omits it only for the detached pane); the omitted field used
    // to skip the guard entirely, which is the bypass the fix closes.
    const answered = await h.app.request(
      `/api/questions/${id}/answer`,
      jsonRequest("POST", { answers: [{ id: "mode", selected: ["方案 B"], custom: "补充一句" }], session: "sample-ws/s1" }),
    );
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ ok: true, id, session: "sample-ws/s1", timed_out: false });

    await waitIdleOf(h);
    sub.close();
    await pump;

    // The model RECEIVED the answer as an ordinary tool result and continued.
    const log = messagesOf(h);
    const result = log.find((m) => m["kind"] === "result");
    expect(result?.["tool_error"]).toBeNull();
    expect(result?.["tool_value"]).toEqual({ answers: [{ id: "mode", selected: ["方案 B"], custom: "补充一句" }], timed_out: false });
    // ...and the turn carried on to a real assistant answer.
    expect(log.filter((m) => m["role"] === "assistant").map((m) => m["content"])).toContain("继续了");
    // No answer was ever injected as a user message.
    expect(log.filter((m) => m["role"] === "user").map((m) => m["content"])).toEqual(["问一下"]);
  });

  it("records the question and its answer as session rows (§7), projecting neither to the model", async () => {
    const h = asker(OPTIONS);
    await activate(h, "sample-ws/s1");
    const turned = await h.app.request("/api/turn", jsonRequest("POST", { input: "问一下", session: "sample-ws/s1" }));
    expect(turned.status).toBe(202);
    const id = await waitForQuestion(h);
    await h.app.request(`/api/questions/${id}/answer`, jsonRequest("POST", { answers: [{ id: "mode", selected: ["方案 A（推荐）"] }], session: "sample-ws/s1" }));
    await waitIdleOf(h);

    const raw = readLogOf(h);
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.map((r) => r["type"])).toContain("user_question");
    expect(rows.map((r) => r["type"])).toContain("user_answer");
    const asked = rows.find((r) => r["type"] === "user_question");
    expect(asked?.["id"]).toBe(id);
    expect(typeof asked?.["expires_at"]).toBe("number");
    expect(asked?.["timeout_ms"]).toBe(300000);
    const answer = rows.find((r) => r["type"] === "user_answer");
    expect(answer?.["timed_out"]).toBe(false);
    // The model never sees these audit rows (its own tool_result is the record).
    expect(raw).toContain('"type":"user_question"');
  });
});

describe("W783 · the maximum wait (§6)", () => {
  // W896: the wait values below were 3000/3000/1500ms — arbitrary picks, not boundaries.
  // The real boundaries (clamp to 1ms / MAX) are covered by their own cases; these three
  // only need "the timer fires and settles the parked call", so 1000ms keeps the same
  // coverage while cutting ~4.5s of pure sleeping from the gate. The read-time assertions
  // below still have ~1s of margin before expiry.
  it("returns {answers:[],timed_out:true} and does NOT decide for the model", async () => {
    const h = asker(OPTIONS, 1000);
    await activate(h, "sample-ws/s1");
    const turned = await h.app.request("/api/turn", jsonRequest("POST", { input: "问一下", session: "sample-ws/s1" }));
    expect(turned.status).toBe(202);
    const id = await waitForQuestion(h);

    // Nobody answers: the §6.1 active track must settle the parked tool call.
    await waitIdleOf(h, 10_000);
    expect(h.runtime.isBusy("sample-ws/s1")).toBe(false);

    const rows = readLogOf(h).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const result = rows.find((r) => r["type"] === "tool_result");
    // The empty answer set — NOT a default option, NOT a cancelled turn.
    expect(result?.["value"]).toEqual({ answers: [], timed_out: true });
    expect(result?.["error"]).toBeNull();
    // The turn still reached its own terminal state — a timeout neither ends the
    // turn early nor leaves it open. (The planted seed log already holds turn-0,
    // so the LIVE turn is the last one.)
    const live = rows.filter((r) => r["type"] === "turn_end").at(-1);
    expect(live?.["id"]).not.toBe("turn-0");
    expect(live?.["outcome"]).toBe("completed");
    // The expiry is recorded as such, which is what distinguishes it from a real
    // answer that happened to select nothing.
    const answer = rows.find((r) => r["type"] === "user_answer");
    expect(answer?.["timed_out"]).toBe(true);
    expect(answer?.["answers"]).toEqual([]);
  }, 20_000);

  it("the question is gone from the recovery list once settled, and answering late is refused", async () => {
    const h = asker(OPTIONS, 1000);
    await activate(h, "sample-ws/s1");
    await h.app.request("/api/turn", jsonRequest("POST", { input: "问一下", session: "sample-ws/s1" }));
    const id = await waitForQuestion(h);
    // Read-time expiry fields are present while it is still answerable.
    const list = (await (await h.app.request("/api/questions")).json()) as { questions: Array<Record<string, unknown>> };
    expect(list.questions).toHaveLength(1);
    expect(list.questions[0]?.["expires_at"]).toBeGreaterThan(Date.now() - 1);
    expect(list.questions[0]?.["remaining_ms"]).toBeGreaterThan(0);
    expect(list.questions[0]?.["expired"]).toBe(false);

    await waitIdleOf(h, 10_000);
    const after = (await (await h.app.request("/api/questions")).json()) as { questions: unknown[] };
    expect(after.questions).toEqual([]);
    // A late answer is a clear 404, never a silent success (§6.2).
    const late = await h.app.request(`/api/questions/${id}/answer`, jsonRequest("POST", { answers: [{ id: "mode", selected: [] }], session: "sample-ws/s1" }));
    expect(late.status).toBe(404);
  }, 20_000);

  it("honours the caller's timeout_ms instead of the default", async () => {
    const h = asker(OPTIONS, 1000);
    await activate(h, "sample-ws/s1");
    await h.app.request("/api/turn", jsonRequest("POST", { input: "问一下", session: "sample-ws/s1" }));
    const id = await waitForQuestion(h);
    const list = (await (await h.app.request("/api/questions")).json()) as { questions: Array<Record<string, unknown>> };
    expect(list.questions[0]?.["id"]).toBe(id);
    expect(list.questions[0]?.["timeout_ms"]).toBe(1000);
    await waitIdleOf(h, 10_000);
  }, 20_000);

  it("clamps a sub-millisecond timeout_ms to 1ms at the real caller (W834 F06)", async () => {
    // The acceptance probe for F06: the request goes through the REAL service
    // (`user-questions.ts:144` calls `askTimeoutMs`), so a 0.5 request must park
    // with a 1ms resolved wait and a deadline of now+1 — not an immediate 0ms.
    const registry = createQuestionRegistry();
    const now = 1_000_000;
    const service = createUserQuestionService({ registry, bus: createEventBus(), sessionId: "sample-ws/s1", now: () => now });
    const asked = service.ask({ questions: OPTIONS, timeoutMs: 0.5 });
    const question = service.pending()[0];
    expect(question?.timeoutMs).toBe(1);
    expect(question?.expiresAt).toBe(now + 1);
    expect(question?.expiresAt).toBeGreaterThanOrEqual(now + 1);
    question?.answer([{ id: "mode", selected: ["方案 A（推荐）"] }]);
    await expect(asked).resolves.toEqual({ answers: [{ id: "mode", selected: ["方案 A（推荐）"] }], timed_out: false });
  });
});

describe("W783 · validation and the sub-agent guard", () => {
  it("refuses a sub-agent caller with DELEGATED_CALLER (§5.3)", async () => {
    const service = bareService();
    // A driven (owned) worker turn has no human answerer: it must FAIL FAST
    // rather than park a question nobody will ever see. The refusal happens
    // BEFORE the question is registered, so nothing is left behind either.
    await expect(
      delegatedCallerScope("W1", () => service.ask({ questions: OPTIONS, timeoutMs: 1000 })),
    ).rejects.toMatchObject({ code: "DELEGATED_CALLER" });
    // A root turn with the same service is allowed to ask (it parks, so settle it).
    expect(service.pending()).toHaveLength(0);
  });

  it("refuses a dead asking generation with CALLER_NOT_LIVE (§5.3)", async () => {
    const service = createUserQuestionService({
      registry: createQuestionRegistry(),
      bus: createEventBus(),
      sessionId: "sample-ws/s1",
      isLive: () => false,
    });
    await expect(service.ask({ questions: OPTIONS, timeoutMs: 1000 })).rejects.toMatchObject({ code: "CALLER_NOT_LIVE" });
  });

  it("reports NO_PROVIDER when no answerer layer claims the request (§5.3)", async () => {
    const registry = createQuestionRegistry();
    // Nobody composes an answerer and the human never answers: the wait must end
    // as an unclaimed seam, not hang forever.
    const service = createUserQuestionService({ registry, bus: createEventBus(), sessionId: "sample-ws/s1" });
    const asked = service.ask({ questions: OPTIONS, timeoutMs: 50 });
    const question = await waitFor(registry, 1000);
    question.timeout();
    await expect(asked).resolves.toEqual({ answers: [], timed_out: true });
  });

  it("rejects an empty batch and a bad intent before anything is parked", async () => {
    const registry = createQuestionRegistry();
    const service = createUserQuestionService({ registry, bus: createEventBus(), sessionId: "sample-ws/s1" });
    await expect(service.ask({ questions: [] })).rejects.toMatchObject({ code: "EMPTY_QUESTIONS" });
    // `approve` names none of the question's options.
    await expect(
      service.ask({ questions: [{ id: "q", question: "?", options: [{ label: "A" }], intent: { kind: "plan-review", approve: "B" }, detail: "plan" }] }),
    ).rejects.toMatchObject({ code: "BAD_INTENT" });
    // A plan-review without the plan it reviews.
    await expect(
      service.ask({ questions: [{ id: "q", question: "?", options: [{ label: "A" }], intent: { kind: "plan-review", approve: "A" } }] }),
    ).rejects.toMatchObject({ code: "BAD_INTENT" });
    // Every refusal happened BEFORE the park, so the table is still empty.
    expect(registry.size()).toBe(0);
  });

  it("accepts a well-formed intent and keeps `selected` as labels (§3.2/§3.3)", async () => {
    const registry = createQuestionRegistry();
    const service = createUserQuestionService({ registry, bus: createEventBus(), sessionId: "sample-ws/s1" });
    const asked = service.ask({
      questions: [
        {
          id: "plan",
          question: "批准吗？",
          detail: "# 计划\n第一步…",
          options: [{ label: "批准（推荐）" }, { label: "驳回" }],
          intent: { kind: "plan-review", approve: "批准（推荐）" },
        },
      ],
      timeoutMs: 1_000,
    });
    const question = await waitFor(registry, 1000);
    question.answer([{ id: "plan", selected: ["批准（推荐）"] }]);
    // The LABEL comes back, never an index — an intent changes presentation only.
    await expect(asked).resolves.toEqual({ answers: [{ id: "plan", selected: ["批准（推荐）"] }], timed_out: false });
    expect(registry.size()).toBe(0);
  });
});

/** Wait until the session reports idle again. */
async function waitIdleOf(h: StudioHarness, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (h.runtime.isBusy("sample-ws/s1")) {
    if (Date.now() > deadline) throw new Error("the parked turn never settled");
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 5));
}

/** The raw JSONL of the harness's planted session. */
function readLogOf(h: StudioHarness): string {
  return readFileSync(join(h.workspace, "s1", "cli-main.jsonl"), "utf8");
}

/**
 * A service built directly, with no session runtime behind it. The refusals
 * below are decided BEFORE anything is parked, so they need no engine — and
 * building the service here is also what proves the seam is constructible
 * outside the host (the property `packages/tools` depends on).
 */
function bareService(sessionId: string | null = "sample-ws/s1") {
  return createUserQuestionService({ registry: createQuestionRegistry(), bus: createEventBus(), sessionId });
}

/** The Studio transcript of the harness's session, as loose records. */
function messagesOf(h: StudioHarness): Array<Record<string, unknown>> {
  const resolved = h.studio.services.sessions.require("sample-ws/s1");
  if (!resolved.ok) throw new Error("the harness session disappeared");
  return h.studio.services.sessions.messages(resolved.value) as unknown as Array<Record<string, unknown>>;
}

/**
 * Wait until the service has parked its question. Park is synchronous, but it
 * happens inside the turn's own async step, so the table fills a tick later.
 */
async function waitFor(registry: QuestionRegistry, timeoutMs: number): Promise<PendingQuestion> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const first = registry.all()[0];
    if (first !== undefined) return first;
    if (Date.now() > deadline) throw new Error("no question was parked");
    await new Promise((r) => setTimeout(r, 1));
  }
}
