/**
 * W768 — a session's tools/沙箱 must run in THAT session's workspace.
 *
 * The bug: the system prompt named the session's workspace (`CelesteaTeamAPI`)
 * while `pwd` reported `/src/celestea_studio`, because the sandbox cwd came from
 * a process-wide env knob (`CELAESTEA_RUN_SHELL_WORKDIR`) that cannot describe
 * more than one of the sessions a process serves. Every assertion below is about
 * the SAME resolution feeding both sides: the prompt's `{{workspace}}` /
 * `{{workspace_dir}}` and the sandbox's cwd/root.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_SERVICE, TOOL_REGISTRY_SERVICE, type Sandbox, type ToolInput, type ToolRegistry } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { sessionWorkspaceOf } from "../store/sessions.js";
import type { StudioHarness } from "../harness.test-util.js";
import { getJson, jsonRequest } from "../harness.test-util.js";
import { createOfflineLlm } from "./offline-llm.js";
import { SessionComposer } from "./session-compose.js";
import type { SessionTarget } from "./engine-session.js";
import { engineOf, makeEngineHarness, plantSession, turns } from "./test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The offline engine profile (no provider, no network). */
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

/**
 * A harness with TWO registered workspaces, each holding one session — the
 * smallest world in which "per session" means anything.
 */
function twoWorkspaceHarness(): { h: StudioHarness; wsA: string; wsB: string; processDir: string } {
  const h = makeEngineHarness({ sessions: { s1: turns(1) } });
  const wsA = h.workspace;
  const wsB = join(h.root, "second-ws");
  const processDir = join(h.root, "process-cwd");
  mkdirSync(wsB, { recursive: true });
  mkdirSync(processDir, { recursive: true });
  // Registering the second workspace goes through the store the prompt reads.
  plantSession(wsB, "s2", turns(1));
  harnesses.push(h);
  return { h, wsA, wsB, processDir };
}

/** The composer the adapter wires, over the harness's own stores. */
function composerOver(h: StudioHarness, env: NodeJS.ProcessEnv): SessionComposer {
  const services = h.studio.services;
  return new SessionComposer({
    env,
    baseProfile: () => PROFILE,
    llm: () => createOfflineLlm({}),
    workers: false,
    ledgerFile: null,
    // Byte for byte the hook app.ts installs.
    resolveSession: (id): SessionTarget | null => {
      const resolved = services.sessions.resolve(id);
      return resolved.ok ? { sessionId: id, dir: resolved.value.dir, workspace: sessionWorkspaceOf(resolved.value) } : null;
    },
  });
}

/** The mounted sandbox of one composed generation (the W768 cwd/root carrier). */
function sandboxOf(ctx: { get<T>(token: string): T | undefined }): Sandbox {
  const sandbox = ctx.get<Sandbox>(SANDBOX_SERVICE);
  expect(sandbox).toBeDefined();
  return sandbox!;
}

describe("W768 per-session workspace", () => {
  it("composes each session's sandbox in ITS workspace, not the process cwd", async () => {
    const { h, wsA, wsB, processDir } = twoWorkspaceHarness();
    await getJson(h.app, "/api/workspaces", jsonRequest("POST", { path: wsB }));
    const env: NodeJS.ProcessEnv = {
      CELAESTEA_RUN_SHELL_WORKDIR: processDir,
      CELESTEA_TOOL_WORKDIR: processDir,
      CELESTEA_TOOL_ROOTS: `${wsA}:${wsB}`,
    };
    const composer = composerOver(h, env);

    const rtA = composer.compose("sample-ws/s1", join(wsA, "s1"));
    const rtB = composer.compose(`${"second-ws"}/s2`, join(wsB, "s2"));
    try {
      const sandboxA = sandboxOf(rtA.ctx);
      const sandboxB = sandboxOf(rtB.ctx);

      // ① each session's cwd/root IS its own workspace...
      expect(sandboxA.config.workdir).toBe(wsA);
      expect(sandboxA.config.root).toBe(wsA);
      expect(sandboxB.config.workdir).toBe(wsB);
      expect(sandboxB.config.root).toBe(wsB);
      // ...they differ from each other and from the process env default.
      expect(sandboxA.config.workdir).not.toBe(sandboxB.config.workdir);
      expect(sandboxA.config.workdir).not.toBe(processDir);

      // ② a session with no resolvable workspace keeps the env posture.
      const detached = composer.compose(null, null);
      try {
        expect(sandboxOf(detached.ctx).config.workdir).toBe(processDir);
      } finally {
        await detached.shutdown();
      }

      // ③ the mounted path guard is scoped to the same workspace: in-workspace
      //    read/write allowed, another workspace writable only if granted.
      const registry = rtA.ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE) as unknown as {
        guardChain(): { check(i: ToolInput): Promise<{ kind: string }> }[];
      };
      const guard = registry.guardChain()[0]!;
      const check = (target: string, name = "read_file"): Promise<{ kind: string }> =>
        guard.check({ call_id: "c1", name, args: { path: target } });
      await expect(check(join(wsA, "cli-main.jsonl"))).resolves.toEqual({ kind: "allow" });
      await expect(check(join(wsA, "written.txt"), "write_file")).resolves.toEqual({ kind: "allow" });
      await expect(check(join(wsB, "intrude.txt"), "write_file")).resolves.toMatchObject({ kind: "deny" });
      await expect(check(join(h.staticRoot, "secret.txt"))).resolves.toMatchObject({ kind: "deny" });
    } finally {
      await rtA.shutdown();
      await rtB.shutdown();
    }
  });

  it("renders the prompt's workspace variables from THAT same resolution", async () => {
    const { h, wsA, wsB } = twoWorkspaceHarness();
    await getJson(h.app, "/api/workspaces", jsonRequest("POST", { path: wsB }));

    // The prompt of the ACTIVE session, over the real HTTP contract.
    const promptOf = async (id: string): Promise<string> => {
      const res = await h.app.request(`/api/sessions/${encodeURIComponent(id)}/activate`, jsonRequest("POST"));
      expect(res.status).toBe(200);
      return String((await getJson(h.app, "/api/config")).body["system_prompt"]);
    };

    const promptA = await promptOf("sample-ws/s1");
    const promptB = await promptOf("second-ws/s2");

    // ④ the prompt names the workspace AND its directory...
    expect(promptA).toContain(`workspace directory, ${wsA}`);
    expect(promptB).toContain(`workspace directory, ${wsB}`);
    expect(promptA).toContain("the active workspace is sample-ws");
    expect(promptB).toContain("the active workspace is second-ws");
    // ...and the old hardcoded cwd sentence is gone.
    expect(promptA).not.toContain("Your working directory is /src/celestea_studio");

    // ④' same source: the value BOTH sides use is `sessionWorkspaceOf(resolve(id))`.
    const services = h.studio.services;
    const resolvedA = services.sessions.resolve("sample-ws/s1");
    const resolvedB = services.sessions.resolve("second-ws/s2");
    expect(resolvedA.ok && resolvedB.ok).toBe(true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    const expectedA = sessionWorkspaceOf(resolvedA.value);
    const expectedB = sessionWorkspaceOf(resolvedB.value);
    expect(expectedA).toEqual({ name: "sample-ws", path: wsA });
    expect(expectedB).toEqual({ name: "second-ws", path: wsB });
    expect(promptA).toContain(expectedA!.path);
    expect(promptB).toContain(expectedB!.path);

    // ④'' A session that is NOT the active one gets its own prompt too: before
    // W768 it inherited the startup-primed prompt, i.e. another workspace's text.
    const ownB = engineOf(h).sessionContext("second-ws/s2");
    expect(ownB.system).toContain(`workspace directory, ${wsB}`);
    expect(ownB.system).toContain("the active workspace is second-ws");
    expect(ownB.system).not.toContain(`workspace directory, ${wsA}`);

    // The sandbox half reads the very same value (see the composer test above);
    // here we pin that the composer resolves it through the same hook.
    const composer = composerOver(h, { CELESTEA_TOOL_WORKDIR: join(h.root, "process-cwd") });
    const rt = composer.compose("second-ws/s2", join(wsB, "s2"));
    try {
      expect(sandboxOf(rt.ctx).config.workdir).toBe(expectedB!.path);
    } finally {
      await rt.shutdown();
    }
  });
});
