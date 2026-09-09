/**
 * Studio entry point (P0: not started by anything; :3778 is reserved for P4+).
 *
 * Deliberately does NOT bind 3777 and never touches production data files.
 */

import { serve } from "@hono/node-server";
import { createStudioApp } from "./app.js";

const port = Number.parseInt(process.env["STUDIO_TS_PORT"] ?? "3778", 10);
const hostname = process.env["STUDIO_TS_BIND"] ?? "127.0.0.1";

const { app, routes } = createStudioApp({
  model: process.env["CELESTEA_MODEL"] ?? "unknown",
  baseUrl: process.env["CELESTEA_BASE_URL"] ?? "http://127.0.0.1:3001/v1",
});

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[celestea-studio-ts] listening on http://${hostname}:${info.port} (${routes.length} contract endpoints)`);
});
