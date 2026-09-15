/**
 * E §4.4 acceptance, host half: D5 (`phase:"fallback"` frame + the status view
 * that `/api/status` renders) and D9 (the switch is OFF unless asked for).
 *
 * The target clients are injected, so this file never opens a socket: what is
 * under test is the WIRING — which frame, which audit line, which status fields
 * and which credential inventory a hand-over produces (§4.2.3's three places).
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantText, statusError, userMessage } from "@celestea/llm";
import type { Llm, StreamEvent } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { createFallbackWiring, type FallbackFrame } from "./fallback-host.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w785-fallback-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE = {
  model: "cfg-model",
  base_url: "https://cfg.example/v1",
  api_key_env: "CFG_KEY",
} as unknown as Profile;

const REQ = { model: "", system: null, messages: [userMessage("hi")], tools: [], max_tokens: null, temperature: null };

/** A scripted seam: throws the given error, or plays the given events. */
function scripted(plan: { error?: unknown; events?: StreamEvent[] }): Llm {
  return {
    generate: async () => {
      if (plan.error !== undefined) throw plan.error;
      const events = plan.events ?? [];
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      };
    },
  };
}

function doneStream(text: string): StreamEvent[] {
  return [
    { kind: "text", text },
    { kind: "done", message: assistantText(text) },
  ];
}

const CONFIG = JSON.stringify({
  version: 1,
  enabled: true,
  targets: [
    { name: "primary", provider: "prov-a", model: "model-a", baseUrl: "https://a.example/v1" },
    { name: "backup", provider: "prov-b", model: "model-b", baseUrl: "https://b.example/v1", apiKeyEnv: "BACKUP_KEY" },
  ],
  policy: { maxAttempts: 2, cooldownMs: 60_000, failureThreshold: 3 },
});

/** D5: the hand-over is visible as an SSE `status` frame and in the status view. */
describe("D5 — visibility of a hand-over (§4.2.3)", () => {
  it("emits one status frame with phase fallback + effective_model, and a status view", async () => {
    const dataDir = tempDir();
    const frames: Array<{ session: string | null; frame: FallbackFrame }> = [];
    const wiring = createFallbackWiring({
      dataDir,
      env: { CELESTEA_LLM_FALLBACK: "on", CELESTEA_LLM_FALLBACKS: CONFIG },
      emit: (session, frame) => frames.push({ session, frame }),
      clientFor: (target) =>
        target.name === "primary"
          ? scripted({ error: statusError(503, "Service Unavailable", "upstream said no") })
          : scripted({ events: doneStream("Hello") }),
    });

    expect(wiring.enabled).toBe(true);
    const llm = wiring.wrap({ inner: scripted({ events: doneStream("never") }), profile: PROFILE, sessionId: "ws1/s1", steps: null, provider: "prov-a" });
    expect(llm).not.toBeNull();
    const seen: StreamEvent[] = [];
    for await (const event of await (llm as Llm).generate(REQ)) seen.push(event);

    // The engine still gets a normal turn: text + the authoritative done.
    expect(seen.map((e) => e.kind)).toEqual(["text", "done"]);
    // (1) one SSE frame, event NAME untouched, payload additive only.
    expect(frames).toHaveLength(1);
    expect(frames[0]?.session).toBe("ws1/s1");
    expect(frames[0]?.frame).toEqual({
      phase: "fallback",
      from: "primary",
      to: "backup",
      reason: "http_503",
      // The frame announces the attempt that is ABOUT to run on the new target.
      attempt: 1,
      effective_model: "model-b",
    });
    // (2) the local audit channel is authoritative and credential-free.
    const audit = readFileSync(join(dataDir, "fallbacks-audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"fallback"');
    expect(audit).toContain('"reason":"http_503"');
    expect(audit).not.toContain("sk-");
    // (3) the status view: chain, the model actually serving, and the U7 finding.
    const view = wiring.view("ws1/s1");
    expect(view.active).toBe(true);
    expect(view.chain).toEqual(["primary", "backup"]);
    expect(view.effective_model).toBe("model-b");
    expect(view.last_reason).toBe("http_503");
    expect(view.targets).toEqual([
      { name: "primary", model: "model-a", available: true, cooling: false },
      { name: "backup", model: "model-b", available: false, cooling: false },
    ]);
    // U7: an unusable target is REPORTED, never silently skipped.
    expect(view.problems.join(" ")).toContain("BACKUP_KEY");
    expect(readFileSync(join(dataDir, "fallbacks-audit.jsonl"), "utf8")).toContain("target_unavailable");
    await wiring.flush();
  });

  it("records a failed platform delivery locally instead of swallowing it", async () => {
    const dataDir = tempDir();
    const wiring = createFallbackWiring({
      dataDir,
      env: {
        CELESTEA_LLM_FALLBACK: "on",
        CELESTEA_LLM_FALLBACKS: CONFIG,
        CELESTEA_AUDIT_URL: "http://127.0.0.1:1/api/audit",
      },
      post: async () => ({ ok: false, status: 502 }),
      clientFor: (target) =>
        target.name === "primary"
          ? scripted({ error: statusError(503, "Service Unavailable", "no") })
          : scripted({ events: doneStream("ok") }),
    });
    const llm = wiring.wrap({ inner: scripted({ events: doneStream("never") }), profile: PROFILE, sessionId: null, steps: null, provider: null });
    for await (const _event of await (llm as Llm).generate(REQ)) void _event;
    await wiring.flush();
    expect(readFileSync(join(dataDir, "fallbacks-audit.jsonl"), "utf8")).toContain("platform_audit_failed");
  });
});

/** D9: switched off = the wiring hands the caller nothing to change. */
describe("D9 — the switch is off by default", () => {
  it("does not arm itself, emits no frame and writes no audit file", async () => {
    const dataDir = tempDir();
    const frames: FallbackFrame[] = [];
    const wiring = createFallbackWiring({
      dataDir,
      env: { CELESTEA_LLM_FALLBACKS: CONFIG },
      emit: (_session, frame) => frames.push(frame),
    });
    expect(wiring.enabled).toBe(false);
    let calls = 0;
    const inner: Llm = {
      generate: async () => {
        calls += 1;
        return { async *[Symbol.asyncIterator]() {} };
      },
    };
    expect(wiring.wrap({ inner, profile: PROFILE, sessionId: "s", steps: null, provider: null })).toBeNull();
    expect(calls).toBe(0);
    expect(frames).toEqual([]);
    expect(existsSync(join(dataDir, "fallbacks-audit.jsonl"))).toBe(false);
  });
});
