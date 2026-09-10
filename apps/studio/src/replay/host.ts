/**
 * The replay host: a throwaway Studio app whose engine is the REAL runtime.
 *
 * Every P5 run gets its own temp data root (workspaces.json + one session
 * directory per fixture copy) and its own engine generation, so a replay can
 * append turns, compact logs and fail loudly without touching `fixtures/` or the
 * operator's data files. The engine's tool roots are pinned to the temp root, so
 * the production path guard stays mounted.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import type { Hono } from "hono";
import { createOfflineLlm, type OfflineLlmOptions } from "../runtime/offline-llm.js";
import { createRealRuntimeAdapter, type RealRuntimeAdapter } from "../runtime/real-runtime-adapter.js";

export interface ReplayHostOptions {
  /** Workspace names to register (their directories are created under root). */
  workspaces: readonly string[];
  /** Offline LLM options for the composed generations. */
  llm?: OfflineLlmOptions;
  /** Static root for the app (defaults to an empty temp build). */
  staticRoot?: string;
}

export interface ReplayHost {
  app: Hono;
  studio: StudioApp;
  runtime: RealRuntimeAdapter;
  /** Temp data root (workspaces + session copies live here). */
  root: string;
  workspacePath(name: string): string;
  cleanup(): void;
}

/** Build a host over a fresh temp root. */
export function createReplayHost(opts: ReplayHostOptions): ReplayHost {
  const root = mkdtempSync(join(tmpdir(), "replay-host-"));
  const staticRoot = opts.staticRoot ?? join(root, "dist");
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>replay</title>\n");
  const workspaces = [...new Set(opts.workspaces)];
  for (const name of workspaces) mkdirSync(join(root, name), { recursive: true });
  // The registry is read EAGERLY at compose time, so it must exist up front.
  writeFileSync(join(root, "workspaces.json"), `${JSON.stringify({ workspaces: workspaces.map((name) => ({ path: join(root, name) })), active_session: null }, null, 2)}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, CELESTEA_TOOL_ROOTS: root };

  const studio = createStudioApp({
    config: loadStudioConfig({ cwd: root, env, paths: { staticRoot } }),
    env,
    runtime: (stores) =>
      createRealRuntimeAdapter({
        profile: {
          model: "offline-replay-model",
          base_url: "http://127.0.0.1:9/v1",
          api_key_env: "CELESTEA_API_KEY",
          reasoning_effort: null,
          max_steps: 4096,
          max_parallel_tool_calls: 4,
          max_output_tokens: null,
          context_window: 1_000_000,
          system_prompt: "engine identity prompt",
        },
        env,
        llm: () => createOfflineLlm(opts.llm ?? {}),
        resultsDir: join(root, "worker-results"),
        resolveSession: (id) => {
          const resolved = stores.sessions.require(id);
          return resolved.ok ? { sessionId: id, dir: resolved.value.dir } : null;
        },
        }),
  });
  return {
    app: studio.app,
    studio,
    runtime: studio.services.runtime as RealRuntimeAdapter,
    root,
    workspacePath: (name: string) => join(root, name),
    cleanup: (): void => rmSync(root, { recursive: true, force: true }),
  };
}

