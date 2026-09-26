/**
 * W9104 host half: the same-target retry as the DEPLOYMENT sees it.
 *
 * Three things only this level can prove:
 *   1. ORDERING — the current target is retried `max_retries` times BEFORE the
 *      chain hands over, and the hand-over still happens afterwards;
 *   2. VISIBILITY — every retry writes an audit line AND publishes a `status`
 *      frame built only from keys the frozen contract already declares
 *      (`from === to` is what says "retry", not "hand-over");
 *   3. TUNABILITY — `POST /api/config.max_retries` validates, applies and is
 *      echoed by `GET /api/config` through the REAL adapter.
 *
 * The target clients are injected (no socket); the config half runs the real
 * engine over the offline seam.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { assistantText, statusError, userMessage } from "@celestea/llm";
import type { Llm, StreamEvent } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import type { EngineProfile } from "../runtime-adapter.js";
import { dirname, join } from "node:path";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../harness.test-util.js";
import { createStudioEngine, type HostRef } from "../app.js";
import { createFallbackWiring, RETRY_ONLY_TARGET, type FallbackFrame } from "./fallback-host.js";
import { activate, makeEngineHarness, runTurnWithFrames } from "./test-util.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9104-retry-"));
  roots.push(dir);
  return dir;
}
const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const h of harnesses.splice(0)) h.cleanup();
});

const PROFILE = { model: "model-a", base_url: "https://a.example/v1", api_key_env: "CFG_KEY" } as unknown as Profile;

/** The engine profile the real harness composes (mirrors test-util's own). */
const ENGINE_PROFILE = {
  model: "deepseek-chat",
  base_url: "https://api.deepseek.com",
  api_key_env: "CELESTEA_API_KEY",
  reasoning_effort: null,
  max_output_tokens: null,
  context_window: 65_536,
  system_prompt: "test",
  max_steps: 16,
  max_parallel_tool_calls: 4,
  request_format: "chat_completions",
  temperature: null,
  max_retries: 1,
} as unknown as EngineProfile;
const REQ = { model: "", system: null, messages: [userMessage("hi")], tools: [], max_tokens: null, temperature: null };

const CONFIG = JSON.stringify({
  version: 1,
  enabled: true,
  targets: [
    { name: "t1", provider: "p", model: "model-a", baseUrl: "https://a.example/v1" },
    { name: "t2", provider: "p", model: "model-b", baseUrl: "https://b.example/v1" },
  ],
  policy: { maxAttempts: 2 },
});

function okStream(text: string): StreamEvent[] {
  return [
    { kind: "text", text },
    { kind: "done", message: assistantText(text) },
  ];
}

/** A seam whose every call answers from the plan, counting its own calls. */
function counting(plan: Array<{ error?: unknown; events?: StreamEvent[] }>): { llm: Llm; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    llm: {
      generate: async () => {
        const step = plan[Math.min(calls, plan.length - 1)] ?? {};
        calls += 1;
        if (step.error !== undefined) throw step.error;
        const events = step.events ?? [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
        };
      },
    },
  };
}

interface Rig {
  dataDir: string;
  frames: FallbackFrame[];
  /** LIVE per-target call counts (read them after the turn, not at build time). */
  calls: () => Record<string, number>;
  wiring: ReturnType<typeof createFallbackWiring>;
}

/** The wiring with an injected per-target seam and an injected (never-waiting) sleep. */
function rig(opts: {
  maxRetries: number;
  t1: Array<{ error?: unknown; events?: StreamEvent[] }>;
  t2?: Array<{ error?: unknown; events?: StreamEvent[] }>;
}): Rig {
  const dataDir = tempDir();
  const frames: FallbackFrame[] = [];
  const seams: Record<string, { llm: Llm; calls: () => number }> = {
    t1: counting(opts.t1),
    t2: counting(opts.t2 ?? [{ events: okStream("from-t2") }]),
  };
  const wiring = createFallbackWiring({
    dataDir,
    env: { CELESTEA_LLM_FALLBACK: "on", CELESTEA_LLM_FALLBACKS: CONFIG },
    emit: (_session, frame) => frames.push(frame),
    maxRetries: () => opts.maxRetries,
    sleep: async () => undefined,
    clientFor: (target) => seams[target.name]?.llm ?? seams["t1"]!.llm,
  });
  return {
    dataDir,
    frames,
    wiring,
    calls: () => ({ t1: seams["t1"]!.calls(), t2: seams["t2"]!.calls() }),
  };
}

/** Drain one turn through the wiring and return the terminal event. */
async function drain(r: Rig): Promise<StreamEvent[]> {
  const llm = r.wiring.wrap({ inner: counting([{ events: okStream("never") }]).llm, profile: PROFILE, sessionId: "ws1/s1", steps: null, provider: "p" });
  const seen: StreamEvent[] = [];
  for await (const event of await (llm as Llm).generate(REQ)) seen.push(event);
  await r.wiring.flush();
  return seen;
}

/** The audit lines written by one turn, parsed. */
function auditLines(dataDir: string): Array<Record<string, unknown>> {
  const path = join(dataDir, "fallbacks-audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("F-06 — retryOnly() composes with an ARMED chain", () => {
  /**
   * The armed chain already puts a retry decorator in front of EVERY target, so
   * the standalone entry point must be inert there. If it were not, a caller that
   * used both would nest two decorators and multiply the attempts (4 -> 16 at the
   * cap). Nothing else in the suite distinguishes "inert" from "accidentally not
   * reached", because no other test calls `retryOnly` on an armed wiring.
   */
  it("returns the chain untouched, so the budget is not applied twice", async () => {
    const r = rig({ maxRetries: 2, t1: [{ events: okStream("from-t1") }] });
    const inner = counting([{ events: okStream("never") }]).llm;
    expect(r.wiring.enabled).toBe(true);
    // Identity, not a wrapper: an armed wiring never re-wraps.
    expect(r.wiring.retryOnly(inner, { name: "t1", model: "model-a" }, "ws1/s1")).toBe(inner);
  });
});
describe("W9104 — retry the CURRENT target, then hand over", () => {
  it("retries the same target until it answers, and never touches the next one", async () => {
    const r = rig({
      maxRetries: 2,
      t1: [
        { error: statusError(503, "Service Unavailable", "no") },
        { error: statusError(503, "Service Unavailable", "no") },
        { events: okStream("from-t1") },
      ],
    });
    const seen = await drain(r);

    expect(seen.at(-1)?.kind).toBe("done");
    // 1 initial + 2 retries on t1; t2 is never reached.
    expect(r.calls()).toEqual({ t1: 3, t2: 0 });
    // The two retries are visible, and they are NOT hand-overs: from === to.
    expect(r.frames).toHaveLength(2);
    expect(r.frames.map((f) => [f.phase, f.from, f.to, f.reason, f.attempt, f.effective_model])).toEqual([
      ["fallback", "t1", "t1", "http_503", 1, "model-a"],
      ["fallback", "t1", "t1", "http_503", 2, "model-a"],
    ]);
    const retries = auditLines(r.dataDir).filter((l) => l["event"] === "retry");
    expect(retries).toHaveLength(2);
    expect(retries.map((l) => l["attempt"])).toEqual([1, 2]);
    expect(retries[0]).toMatchObject({ from: "t1", to: "t1", reason: "http_503", model: "model-a" });
  });

  it("hands over only AFTER the retry budget is spent (retry-first ordering)", async () => {
    const r = rig({
      maxRetries: 1,
      t1: [{ error: statusError(503, "Service Unavailable", "no") }],
      t2: [{ events: okStream("from-t2") }],
    });
    const seen = await drain(r);

    expect(seen.at(-1)?.kind).toBe("done");
    // t1: 1 initial + 1 retry; only then does t2 run.
    expect(r.calls()).toEqual({ t1: 2, t2: 1 });
    expect(r.frames).toHaveLength(2);
    // First frame = the retry (same target), second = the real hand-over.
    expect(r.frames[0]).toMatchObject({ from: "t1", to: "t1", reason: "http_503", attempt: 1 });
    expect(r.frames[1]).toMatchObject({ from: "t1", to: "t2", reason: "http_503", attempt: 1, effective_model: "model-b" });
    const lines = auditLines(r.dataDir);
    expect(lines.filter((l) => l["event"] === "retry")).toHaveLength(1);
    expect(lines.filter((l) => l["event"] === "fallback")).toHaveLength(1);
  });

  it("max_retries 0 restores the pre-W9104 path exactly (one call per target, no retry line)", async () => {
    const r = rig({ maxRetries: 0, t1: [{ error: statusError(503, "Service Unavailable", "no") }] });
    await drain(r);

    expect(r.calls()).toEqual({ t1: 1, t2: 1 });
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ from: "t1", to: "t2" });
    expect(auditLines(r.dataDir).some((l) => l["event"] === "retry")).toBe(false);
  });

  it("never retries a non-retryable status, even with the budget raised", async () => {
    const r = rig({ maxRetries: 3, t1: [{ error: statusError(400, "Bad Request", "bad") }] });
    const llm = r.wiring.wrap({ inner: counting([{ events: okStream("never") }]).llm, profile: PROFILE, sessionId: null, steps: null, provider: null });
    await expect(async () => {
      for await (const _e of await (llm as Llm).generate(REQ)) void _e;
    }).rejects.toThrow(/Bad Request/);
    await r.wiring.flush();

    expect(r.calls()).toEqual({ t1: 1, t2: 0 });
    expect(r.frames).toEqual([]);
    expect(auditLines(r.dataDir).some((l) => l["event"] === "retry")).toBe(false);
  });
});

/**
 * F-06 / W9206-31-adjacent: the retry budget must be reachable through the REAL
 * adapter with NO fallback chain configured (the deployment default).
 *
 * Why this block exists: the previous suite injected its own `maxRetries` into
 * `createFallbackWiring` AND always turned `CELESTEA_LLM_FALLBACK` on, so it
 * proved the wiring half but never that a retry reaches the provider. The
 * mutation "real-runtime-adapter: `maxRetries: () => 0`" left the whole file
 * green. These cases drive a real turn through `RealRuntimeAdapter` with a
 * counting seam, so they fail the moment the adapter stops forwarding the
 * budget (mutation negative control is in the report).
 */
describe("F-06 — the retry budget reaches the provider through the REAL adapter", () => {
  /** A seam that fails the first `failures` calls then answers, counting every call. */
  function flakySeam(failures: number): { llm: (p: Profile) => Llm; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      llm: () => ({
        generate: async () => {
          calls += 1;
          if (calls <= failures) throw statusError(503, "Service Unavailable", `attempt ${calls}`);
          return {
            async *[Symbol.asyncIterator]() {
              yield { kind: "text", text: "recovered" };
              yield { kind: "done", message: assistantText("recovered") };
            },
          };
        },
      }),
    };
  }

  /** A harness with NO fallback chain (the default) and a counting seam. */
  async function realHarness(failures: number): Promise<{ h: StudioHarness; seam: { llm: (p: Profile) => Llm; calls: () => number } }> {
    const seam = flakySeam(failures);
    const host: HostRef = { services: null };
    const h = makeHarness({
      session: { name: "s1" },
      engineFactory: createStudioEngine((stores) => {
        const wsPath = stores.workspaces.workspacePath("sample-ws");
        const dataRoot = wsPath === undefined ? process.cwd() : dirname(wsPath);
        return {
          workspacesFile: join(dataRoot, "workspaces.json"),
          env: { ...process.env, CELESTEA_TOOL_ROOTS: wsPath ?? "", CELESTEA_LLM_MODE: "offline" },
          profile: ENGINE_PROFILE,
          providerLabel: null,
          host,
          llm: seam.llm,
        };
      }),
    });
    host.services = h.studio.services;
    harnesses.push(h);
    return { h, seam };
  }

  it("retries the same endpoint by default, and the retry is visible in the audit channel", async () => {
    const { h, seam } = await realHarness(1);
    // Default budget = 1 extra attempt; the fallback switch is NOT set.
    await activate(h, "sample-ws/s1");
    const turn = await runTurnWithFrames(h, "go");

    // The provider was called twice: the 503 plus the re-issue.
    expect(seam.calls()).toBe(2);
    expect(turn.frames.some((f) => f.event === "text")).toBe(true);
    // The retry is announced on the bus with from === to (retry, not hand-over).
    const retryFrames = turn.frames.filter((f) => f.event === "status" && f.payload["phase"] === "fallback");
    expect(retryFrames).toHaveLength(1);
    expect(retryFrames[0]?.payload).toMatchObject({ from: RETRY_ONLY_TARGET, to: RETRY_ONLY_TARGET, reason: "http_503", attempt: 1 });
  });

  it("max_retries 0 disables the extra call on the default path", async () => {
    const { h, seam } = await realHarness(1);
    await activate(h, "sample-ws/s1");
    const off = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: 0 }));
    expect(off.body["max_retries"]).toBe(0);

    const turn = await runTurnWithFrames(h, "go");

    // Exactly one provider call: the 503 is NOT re-issued.
    expect(seam.calls()).toBe(1);
    expect(turn.frames.some((f) => f.event === "status" && f.payload["phase"] === "fallback")).toBe(false);
    expect(turn.frames.at(-1)?.payload["phase"]).toBe("error");
  });

  it("raising the budget through POST /api/config raises the number of real calls", async () => {
    const { h, seam } = await realHarness(3);
    await activate(h, "sample-ws/s1");
    const applied = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: 3 }));
    expect(applied.body["max_retries"]).toBe(3);

    const turn = await runTurnWithFrames(h, "go");

    // 1 initial + 3 retries: the knob is live, not decorative.
    expect(seam.calls()).toBe(4);
    expect(turn.frames.some((f) => f.event === "text")).toBe(true);
  });

  it("does not retry a non-retryable status on the default path", async () => {
    let calls = 0;
    const host: HostRef = { services: null };
    const h = makeHarness({
      session: { name: "s1" },
      engineFactory: createStudioEngine((stores) => {
        const wsPath = stores.workspaces.workspacePath("sample-ws");
        const dataRoot = wsPath === undefined ? process.cwd() : dirname(wsPath);
        return {
          workspacesFile: join(dataRoot, "workspaces.json"),
          env: { ...process.env, CELESTEA_TOOL_ROOTS: wsPath ?? "", CELESTEA_LLM_MODE: "offline" },
          profile: ENGINE_PROFILE,
          providerLabel: null,
          host,
          llm: () => ({
            generate: async () => {
              calls += 1;
              throw statusError(400, "Bad Request", "bad request");
            },
          }),
        };
      }),
    });
    host.services = h.studio.services;
    harnesses.push(h);

    await activate(h, "sample-ws/s1");
    await runTurnWithFrames(h, "go");

    expect(calls).toBe(1);
  });
});

describe("W9104 — POST /api/config tunes max_retries (real adapter)", () => {
  it("echoes the default, applies an accepted value and refuses an out-of-range one", async () => {
    const h = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(h);

    const before = await getJson(h.app, "/api/config");
    expect(before.body["max_retries"]).toBe(1);

    const applied = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: 3 }));
    expect(applied.status).toBe(200);
    expect(applied.body["max_retries"]).toBe(3);
    // The engine seam reports the same value (one source of truth).
    expect(h.runtime.profile().max_retries).toBe(3);
    // ... and a later GET still echoes it (not just the POST response).
    expect((await getJson(h.app, "/api/config")).body["max_retries"]).toBe(3);

    const zero = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: 0 }));
    expect(zero.body["max_retries"]).toBe(0);

    // Out of range is REFUSED, never silently clamped.
    const tooBig = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: 4 }));
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toEqual({ ok: false, error: "max_retries must be between 0 and 3" });
    const negative = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: -1 }));
    expect(negative.status).toBe(400);
    expect(negative.body).toEqual({ ok: false, error: "max_retries must be between 0 and 3" });
    // A non-number keeps the shared numeric-field wording (422).
    const notNumber = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: "2" }));
    expect(notNumber.status).toBe(422);
    expect(notNumber.body).toEqual({ ok: false, error: "field 'max_retries' must be a number" });
    // A refused write changed nothing.
    expect((await getJson(h.app, "/api/config")).body["max_retries"]).toBe(0);
  });

  it("applies a fractional value by truncation, like the other numeric knobs", async () => {
    const h = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(h);
    const res = await getJson(h.app, "/api/config", jsonRequest("POST", { max_retries: 2.9 }));
    expect(res.body["max_retries"]).toBe(2);
  });
});
