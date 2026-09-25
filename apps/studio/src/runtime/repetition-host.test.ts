/**
 * W1510 — the host half of the repetition port: the perturbation must actually
 * be reachable from the loop.
 *
 * The ported strategy re-issues a collapsed attempt on a perturbed route, and the
 * loop discovers that route by asking `isPerturbable(llm)` on the seam it got.
 * That makes the WRAPPING ORDER load-bearing: if a decorator sits OUTSIDE the
 * perturbation wrapper, `isPerturbable` is false and the retry silently stops
 * being perturbed. No engine-level test can see that, because the engine tests
 * hand the loop a bare fake.
 *
 * So this file observes the REAL composition: the same `SessionComposer` the host
 * installs, and the `Llm` its composed Context provides to the loop.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPerturbable } from "@celestea/agent-loop";
import { LLM_SERVICE, type Llm } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { sessionWorkspaceOf } from "../store/sessions.js";
import type { StudioHarness } from "../harness.test-util.js";
import { createOfflineLlm } from "./offline-llm.js";
import { SessionComposer } from "./session-compose.js";
import type { SessionTarget } from "./engine-session.js";
import { makeEngineHarness } from "./test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** A profile whose only interesting field here is the reasoning effort. */
const PROFILE: Profile = {
  model: "deepseek-flash",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 4096,
  max_parallel_tool_calls: 4,
  reasoning_effort: "max",
  max_output_tokens: null,
  context_window_tokens: 1_000_000,
  system_prompt: "engine identity prompt",
  request_format: "chat_completions",
  temperature: null,
};

/** The host's composer, built the way `process-shutdown.test.ts` builds it. */
function composerOver(h: StudioHarness, llm: (profile: Profile) => Llm): SessionComposer {
  const services = h.studio.services;
  return new SessionComposer({
    env: {},
    baseProfile: () => PROFILE,
    llm,
    workers: false,
    ledgerFile: null,
    resolveSession: (id): SessionTarget | null => {
      const resolved = services.sessions.resolve(id);
      return resolved.ok ? { sessionId: id, dir: resolved.value.dir, workspace: sessionWorkspaceOf(resolved.value) } : null;
    },
  });
}

/** The `Llm` the engine's own Context hands to the loop, for one session. */
function composedLlm(h: StudioHarness, llm?: (profile: Profile) => Llm): Llm {
  const rt = composerOver(h, llm ?? (() => createOfflineLlm({}))).compose("sample-ws/s1", join(h.workspace, "s1"));
  const seam = rt.ctx.get<Llm>(LLM_SERVICE);
  expect(seam, "the composed Context must provide the Llm seam").toBeDefined();
  return seam as Llm;
}

describe("W1510 host wiring — the perturbation is reachable", () => {
  it("the Llm the loop receives is perturbable", () => {
    // Without this the loop's `isPerturbable(seams.llm)` is false in production,
    // so every retry is issued on the SAME route — the exact failure the ported
    // perturbation exists to avoid. The wrapping order IS the test.
    const h = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(h);

    expect(isPerturbable(composedLlm(h))).toBe(true);
  });

  it("noteRetry() rebuilds the route one rung down, through the HOST factory", () => {
    // The rebuild must go through the host's own factory, so the ledger, the
    // fallback decorator and the attachment layer survive the re-issue instead
    // of being bypassed by a bare client.
    const efforts: Array<string | null> = [];
    const h = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(h);
    const seam = composedLlm(h, (profile: Profile) => {
      efforts.push(profile.reasoning_effort);
      return createOfflineLlm({});
    });
    efforts.length = 0;

    // Narrow through the guard the LOOP itself uses, so the test cannot drift
    // from the production discovery path.
    expect(isPerturbable(seam)).toBe(true);
    if (!isPerturbable(seam)) return;
    seam.noteRetry();
    void seam.generate({ model: "deepseek-flash", system: null, messages: [], tools: [], max_tokens: null, temperature: null });

    expect(efforts).toEqual(["high"]);
  });
});
