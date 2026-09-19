/**
 * `startStudioServer` (H): the ONE reusable server bootstrap.
 *
 * `apps/studio/src/main.ts` (source checkout) and the `celestea` CLI
 * (`packages/cli`) both call this, so the startup log lines and the W742
 * graceful-teardown order exist in exactly one place. `main.ts` stays a thin
 * wrapper that pins the historical source defaults; the CLI passes its own
 * flags.
 *
 * Teardown order is the W742 contract (do not reorder):
 *   signal -> stop accepting traffic (bounded grace) -> flush grants audit ->
 *   engine down (workers settled, logs closed) -> let the loop drain.
 */

import { serve } from "@hono/node-server";
import { createStudioApp, type StudioAppOptions } from "./app.js";
import { loadStudioConfig } from "./config.js";
import { assertBindIsSafe } from "./auth/api-token.js";
import { engineLlmView } from "./runtime/llm-assembly.js";
import type { RealRuntimeAdapter } from "./runtime/real-runtime-adapter.js";
import { autowakeEnabled, ENV_AUTOWAKE } from "@celestea/runtime";

/** Env knob: drain window before leftover sockets are cut. */
export const ENV_DRAIN_MS = "CELESTEA_SHUTDOWN_DRAIN_MS";
/** Env knob: ceiling for the whole teardown. */
export const ENV_TEARDOWN_MS = "CELESTEA_SHUTDOWN_TIMEOUT_MS";

export interface StudioServerOptions extends StudioAppOptions {
  port: number;
  hostname: string;
  /** Emit the startup banner (default true; tests may silence it). */
  log?: boolean;
  /** Called once the listener is up, with the ACTUAL bound port. */
  onListening?: (info: { port: number; hostname: string; endpointCount: number }) => void;
}

export interface StudioServerHandle {
  port: number;
  hostname: string;
  endpointCount: number;
  /** Resolves once the socket is bound (the ACTUAL address is then known). */
  listening: Promise<{ port: number; hostname: string }>;
  /** Graceful stop (idempotent); resolves once the loop may drain. */
  stop(signal: string): Promise<void>;
}

interface ServeHandle {
  close(cb?: () => void): void;
  closeAllConnections?(): void;
}

/** The one startup banner (kept out of `startStudioServer` for the size rule). */
function logListeningBanner(info: {
  hostname: string;
  port: number;
  endpointCount: number;
  view: ReturnType<typeof engineLlmView>;
  apiKeyEnv: string;
  env: NodeJS.ProcessEnv;
}): void {
  console.log(`[celestea-studio-ts] listening on http://${info.hostname}:${info.port} (${info.endpointCount} contract endpoints)`);
  const v = info.view;
  console.log(
    `[celestea-studio-ts] llm: mode=${v.mode} model=${v.model} base_url=${v.baseUrl} ` +
      `key=${v.hasApiKey ? "set" : "missing"} context_window=${v.contextWindow ?? "n/a"} ` +
      `timeouts(c/r/i)=${v.timeouts.connectMs ?? "off"}/${v.timeouts.responseMs ?? "off"}/${v.timeouts.idleMs ?? "off"}ms`,
  );
  console.log(`[celestea-studio-ts] reasoning_effort=${v.reasoningEffort ?? "off"} max_output_tokens=${v.maxOutputTokens ?? "off"}`);
  console.log(`[celestea-studio-ts] api_key_env=${info.apiKeyEnv} (key read from the environment only)`);
  console.log(
    autowakeEnabled(info.env)
      ? `[celestea-studio-ts] autowake: enabled (a worker receipt wakes its host session; ${ENV_AUTOWAKE}=0 disables)`
      : `[celestea-studio-ts] autowake: disabled by ${ENV_AUTOWAKE}`,
  );
}

/** Boot the studio HTTP server; returns a handle whose `stop` is the teardown. */
export function startStudioServer(options: StudioServerOptions): StudioServerHandle {
  const env = options.env ?? process.env;
  // H: resolve the config HERE so the listening callback can write the ACTUAL
  // address back into it. `services.config` is the same object, so
  // `GET /api/health.bind` can never disagree with the socket the process is on
  // (the "never lie to the operator" rule); `--port 0` reports the real port.
  const config = options.config ?? loadStudioConfig({ cwd: options.cwd, env });
  // H-security: a non-loopback listener with no token is a remote-shell hole
  // (POST /api/exec). Refuse BEFORE composing or binding; never degrade silently.
  assertBindIsSafe(options.hostname, config.authToken);
  const { app, routes, services } = createStudioApp({ ...options, config });
  const profile = services.runtime.profile();
  const view = engineLlmView(profile, env);
  const loud = options.log ?? true;
  const drainMs = Number.parseInt(env[ENV_DRAIN_MS] ?? "2000", 10);
  const teardownMs = Number.parseInt(env[ENV_TEARDOWN_MS] ?? "5000", 10);

  let boundPort = options.port;
  let announceListening: (info: { port: number; hostname: string }) => void = () => {};
  const listening = new Promise<{ port: number; hostname: string }>((resolve) => {
    announceListening = resolve;
  });
  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname }, (info) => {
    boundPort = info.port;
    config.bind = `${options.hostname}:${info.port}`;
    announceListening({ port: info.port, hostname: options.hostname });
    if (loud) {
      logListeningBanner({ hostname: options.hostname, port: info.port, endpointCount: routes.length, view, apiKeyEnv: profile.api_key_env, env });
    }
    options.onListening?.({ port: info.port, hostname: options.hostname, endpointCount: routes.length });
  }) as unknown as ServeHandle;

  const engine = services.runtime as Partial<RealRuntimeAdapter>;
  let stopping = false;
  const log = (line: string): void => {
    if (loud) console.log(`[celestea-studio-ts] ${line}`);
  };

  async function within(work: Promise<void> | void, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([Promise.resolve(work), deadline]);
    } catch (e) {
      log(`teardown step failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function stopTraffic(): Promise<void> {
    await within(
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      drainMs,
    );
    server.closeAllConnections?.();
  }

  async function stop(signal: string): Promise<void> {
    if (stopping) {
      log(`${signal} again — exiting now (in-flight work is dropped)`);
      return;
    }
    stopping = true;
    log(`${signal} received — draining (grace ${drainMs}ms)`);
    await stopTraffic();
    log("traffic stopped (listener closed, leftover sockets cut)");
    await within(services.grants.audit.flush(), drainMs);
    log("audit flushed");
    await within(engine.shutdown?.(), teardownMs);
    log("engine stopped (workers settled, session logs closed) — loop may drain");
  }

  return {
    get port() {
      return boundPort;
    },
    hostname: options.hostname,
    endpointCount: routes.length,
    listening,
    stop,
  };
}
