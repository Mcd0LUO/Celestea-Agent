/**
 * Handler registry — the ONLY place that knows every endpoint group.
 *
 * Each `registerXxx` returns the contract ids it bound, and `app.ts` asserts
 * the union equals the frozen 39. A route can therefore never be silently
 * dropped: adding an endpoint to `contracts/endpoints.json` without a handler
 * fails at startup with the missing id.
 *
 * Module map:
 *   common.ts        error/body/field helpers shared by every handler
 *   config-shape.ts  the /api/config body assembled from live stores
 *   health.ts        GET  /api/health | /api/status | /api/tools
 *   dialog.ts        GET  /api/events (SSE) | POST /api/turn | /api/cancel | /api/clear
 *   config.ts        GET+POST /api/config
 *   sessions.ts      GET+POST /api/sessions | {id}/messages | {id}/activate
 *   session-move.ts  {id}/rename | {id}/branch | {id}/compact | archive | unarchive | batch-*
 *   workspaces.ts    /api/workspaces (+rename/delete/batch-delete)
 *   fs.ts            GET /api/fs/browse
 *   providers.ts     /api/providers (+delete/test/models fetch/default)
 *   prompts.ts       /api/prompts (+delete/default)
 *   worker.ts        /api/worker/spawn | send | status
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { registerConfig } from "./config.js";
import { registerDialog } from "./dialog.js";
import { registerFs } from "./fs.js";
import { registerHealth } from "./health.js";
import { registerPrompts } from "./prompts.js";
import { registerProviders } from "./providers.js";
import { registerSessionMoves } from "./session-move.js";
import { registerSessions } from "./sessions.js";
import { registerWorker } from "./worker.js";
import { registerWorkspaces } from "./workspaces.js";
import type { Deps } from "./common.js";

export function registerHandlers(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [
    ...registerHealth(app, deps, table),
    ...registerDialog(app, deps, table),
    ...registerConfig(app, deps, table),
    ...registerSessions(app, deps, table),
    ...registerSessionMoves(app, deps, table),
    ...registerWorkspaces(app, deps, table),
    ...registerFs(app, deps, table),
    ...registerProviders(app, deps, table),
    ...registerPrompts(app, deps, table),
    ...registerWorker(app, deps, table),
  ];
}

export type { Deps } from "./common.js";
