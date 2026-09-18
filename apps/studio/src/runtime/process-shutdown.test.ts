/**
 * W855 #1: the host wires `ProcessRegistry.dispose()` into the generation
 * shutdown hooks (`session-compose.ts`), so a detached `run_shell
 * background:true` child cannot outlive `Runtime.shutdown()`.
 *
 * Anti-regression: before the wiring, `dispose()` had ZERO callers, so
 * `kill` was never called and `registry.size` stayed 1 — every assertion that
 * matters here goes RED. The test drives the SAME `SessionComposer` the host
 * installs, with a fake child (deterministic: no real process/sandbox).
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxChild } from "@celestea/core";
import { ProcessRegistry, PROCESS_REGISTRY_SERVICE } from "@celestea/tools";
import type { Profile } from "@celestea/runtime";
import { sessionWorkspaceOf } from "../store/sessions.js";
import type { StudioHarness } from "../harness.test-util.js";
import { createOfflineLlm } from "./offline-llm.js";
import { SessionComposer } from "./session-compose.js";
import type { SessionTarget } from "./engine-session.js";
import { makeEngineHarness, turns } from "./test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  vi.restoreAllMocks();
});

const PROFILE: Profile = {
  model: "offline-model",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 4096,
  max_parallel_tool_calls: 4,
  reasoning_effort: null,
  max_output_tokens: null,
  context_window_tokens: 1_000_000,
  system_prompt: "engine identity prompt",
  request_format: "chat_completions",
  temperature: null,
};

function composerOver(h: StudioHarness): SessionComposer {
  const services = h.studio.services;
  return new SessionComposer({
    env: {},
    baseProfile: () => PROFILE,
    llm: () => createOfflineLlm({}),
    workers: false,
    ledgerFile: null,
    resolveSession: (id): SessionTarget | null => {
      const resolved = services.sessions.resolve(id);
      return resolved.ok ? { sessionId: id, dir: resolved.value.dir, workspace: sessionWorkspaceOf(resolved.value) } : null;
    },
  });
}

/** A registered detached child whose `kill`/`terminate` we can observe. */
function fakeChild(): { child: SandboxChild; kill: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  const kill = vi.fn();
  const terminate = vi.fn();
  const child = {
    pid: 4242,
    stdin: null,
    stdout: null,
    stderr: null,
    wait: () => new Promise<never>(() => {}),
    terminate,
    kill,
  } as unknown as SandboxChild;
  return { child, kill, terminate };
}

describe("W855 #1 process-registry shutdown", () => {
  it("shutdown kills + unregisters the session's detached children", async () => {
    const h = makeEngineHarness({ sessions: { s1: turns(1) } });
    harnesses.push(h);
    const rt = composerOver(h).compose("sample-ws/s1", join(h.workspace, "s1"));
    const registry = rt.ctx.get<ProcessRegistry>(PROCESS_REGISTRY_SERVICE);
    expect(registry).toBeDefined();
    const { child, kill } = fakeChild();
    registry!.insert(child);
    expect(registry!.size).toBe(1);

    await rt.shutdown();

    // The hook ran: the child was killed and the registry drained.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(registry!.size).toBe(0);
  });

  it("repeated shutdown does not re-dispose the same generation", async () => {
    const h = makeEngineHarness({ sessions: { s1: turns(1) } });
    harnesses.push(h);
    const rt = composerOver(h).compose("sample-ws/s1", join(h.workspace, "s1"));
    const registry = rt.ctx.get<ProcessRegistry>(PROCESS_REGISTRY_SERVICE)!;
    const dispose = vi.spyOn(registry, "dispose");

    await rt.shutdown();
    await rt.shutdown();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
