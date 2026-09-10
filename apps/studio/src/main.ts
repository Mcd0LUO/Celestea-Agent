/**
 * Studio process entry (CLI entry point: console output is allowed here).
 *
 * The TS studio listens on 3778 by default so it can run next to the Rust
 * reference on 3777 during the migration. Nothing here touches production data
 * files unless the caller points the path env vars at them.
 */

import { serve } from "@hono/node-server";
import { createStudioApp } from "./app.js";

const port = Number.parseInt(process.env["STUDIO_TS_PORT"] ?? "3778", 10);
const hostname = process.env["STUDIO_TS_BIND"] ?? "127.0.0.1";

const { app, routes } = createStudioApp();

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[celestea-studio-ts] listening on http://${hostname}:${info.port} (${routes.length} contract endpoints)`);
});
