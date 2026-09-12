/**
 * Studio process entry (CLI entry point: console output is allowed here).
 *
 * The TS studio listens on 3778 by default so it can run next to the Rust
 * reference on 3777 during the migration. Nothing here touches production data
 * files unless the caller points the path env vars at them.
 *
 * Startup also reports the resolved provider target (model / base_url / mode /
 * whether a key is present) so an operator can see which real model the engine
 * is about to talk to — never the key itself.
 *
 * W742 §3 — GRACEFUL SHUTDOWN. `SIGTERM`/`SIGINT` (systemd restart, `docker
 * stop`, Ctrl-C, an operator's `kill`) used to end the process outright: the
 * three lifecycle hooks that exist for exactly that moment had NO production
 * caller, so in-flight workers were abandoned (their rows left RUNNING), session
 * log descriptors stayed open, an append to the usage ledger could be cut
 * mid-line and the platform audit channel dropped whatever it had in flight. The
 * signal path is now explicit and ordered:
 *
 *   signal -> stop accepting traffic (bounded grace: SSE streams never end on
 *   their own, so the remaining sockets are cut when the grace runs out) ->
 *   flush the grants audit channel -> tear the engine down
 *   (`registry.shutdown()`: abort the drivers, settle their rows, close every
 *   session log, disarm the idle-reclaimer timer) -> let the loop drain.
 *
 * The exit is NOT forced. The safety timer that caps a hung teardown is `unref`ed
 * and intentionally left armed: a leaked timer, socket or descriptor keeps the
 * loop alive, the timer then fires and the process exits 1 with a log line —
 * instead of the leak being masked by `process.exit(0)`.
 */

import { serve } from "@hono/node-server";
import { createStudioApp } from "./app.js";
import { engineLlmView } from "./runtime/llm-assembly.js";
import type { RealRuntimeAdapter } from "./runtime/real-runtime-adapter.js";
import { autowakeEnabled, ENV_AUTOWAKE } from "@celestea/runtime";

const port = Number.parseInt(process.env["STUDIO_TS_PORT"] ?? "3778", 10);
const hostname = process.env["STUDIO_TS_BIND"] ?? "127.0.0.1";
/** How long in-flight requests may finish before their sockets are cut. */
const DRAIN_MS = Number.parseInt(process.env["CELESTEA_SHUTDOWN_DRAIN_MS"] ?? "2000", 10);
/** Ceiling for the whole teardown: a hung hook must not hang the operator's restart. */
const TEARDOWN_MS = Number.parseInt(process.env["CELESTEA_SHUTDOWN_TIMEOUT_MS"] ?? "5000", 10);

const { app, routes, services } = createStudioApp();
const profile = services.runtime.profile();
const view = engineLlmView(profile, process.env);

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[celestea-studio-ts] listening on http://${hostname}:${info.port} (${routes.length} contract endpoints)`);
  console.log(
    `[celestea-studio-ts] llm: mode=${view.mode} model=${view.model} base_url=${view.baseUrl} ` +
      `key=${view.hasApiKey ? "set" : "missing"} context_window=${view.contextWindow ?? "n/a"} ` +
      `timeouts(c/r/i)=${view.timeouts.connectMs ?? "off"}/${view.timeouts.responseMs ?? "off"}/${view.timeouts.idleMs ?? "off"}ms`,
  );
  console.log(`[celestea-studio-ts] reasoning_effort=${view.reasoningEffort ?? "off"} max_output_tokens=${view.maxOutputTokens ?? "off"}`);
  console.log(`[celestea-studio-ts] api_key_env=${profile.api_key_env} (key read from the environment only)`);
  // W769: the operator must be able to see at a glance whether receipts wake
  // their host session by themselves.
  console.log(
    autowakeEnabled(process.env)
      ? `[celestea-studio-ts] autowake: enabled (a worker receipt wakes its host session; ${ENV_AUTOWAKE}=0 disables)`
      : `[celestea-studio-ts] autowake: disabled by ${ENV_AUTOWAKE}`,
  );
});

/** The real engine's lifecycle handles (absent on an injected non-real adapter). */
const engine = services.runtime as Partial<RealRuntimeAdapter>;
let stopping = false;

function log(line: string): void {
  console.log(`[celestea-studio-ts] ${line}`);
}

/** Await `work`, but never longer than `ms`; a failing step never blocks the exit. */
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

/**
 * Stop accepting traffic, then cut what is left: a request may finish inside the
 * grace period, but an SSE stream is open by design and would never let the
 * listener close on its own.
 */
async function stopTraffic(): Promise<void> {
  await within(new Promise<void>((resolve) => {
    server.close(() => resolve());
  }), DRAIN_MS);
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
}

/** One graceful stop; a second signal gives up on the teardown and exits 1. */
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    log(`${signal} again — exiting now (in-flight work is dropped)`);
    process.exit(1);
  }
  stopping = true;
  const failsafe = setTimeout(() => {
    log(`teardown exceeded ${TEARDOWN_MS}ms — something still holds the event loop`);
    process.exit(1);
  }, TEARDOWN_MS);
  failsafe.unref();
  log(`${signal} received — draining (grace ${DRAIN_MS}ms)`);
  await stopTraffic();
  log("traffic stopped (listener closed, leftover sockets cut)");
  await within(services.grants.audit.flush(), DRAIN_MS);
  log("audit flushed");
  await within(engine.shutdown?.(), TEARDOWN_MS);
  log("engine stopped (workers settled, session logs closed) — loop may drain");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
