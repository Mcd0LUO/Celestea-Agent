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
 */

import { serve } from "@hono/node-server";
import { createStudioApp } from "./app.js";
import { engineLlmView } from "./runtime/llm-assembly.js";

const port = Number.parseInt(process.env["STUDIO_TS_PORT"] ?? "3778", 10);
const hostname = process.env["STUDIO_TS_BIND"] ?? "127.0.0.1";

const { app, routes, services } = createStudioApp();
const profile = services.runtime.profile();
const view = engineLlmView(profile, process.env);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[celestea-studio-ts] listening on http://${hostname}:${info.port} (${routes.length} contract endpoints)`);
  console.log(
    `[celestea-studio-ts] llm: mode=${view.mode} model=${view.model} base_url=${view.baseUrl} ` +
      `key=${view.hasApiKey ? "set" : "missing"} context_window=${view.contextWindow ?? "n/a"} ` +
      `timeouts(c/r/i)=${view.timeouts.connectMs ?? "off"}/${view.timeouts.responseMs ?? "off"}/${view.timeouts.idleMs ?? "off"}ms`,
  );
  console.log(`[celestea-studio-ts] reasoning_effort=${view.reasoningEffort ?? "off"} max_output_tokens=${view.maxOutputTokens ?? "off"}`);
  console.log(`[celestea-studio-ts] api_key_env=${profile.api_key_env} (key read from the environment only)`);
});
