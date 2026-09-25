/**
 * Route table derived from the frozen contract.
 *
 * 69 endpoints (73 method+path combos minus the 4 static routes).
 * The contract path params use `{id}`; Hono uses `:id`, so paths are translated here
 * once and the translation is asserted in tests.
 *
 * W516 added `GET|POST|DELETE /api/sessions/{id}/grants` and
 * `GET /api/sessions/{id}/grants/confirm-token` (39 -> 43); W725 added
 * `GET /api/sessions/{id}/context` (43 -> 44). W767 added Studio's own login
 * cookie gate: `GET /login`, `POST /auth/login`, `GET /auth/check` (44 -> 47;
 * the first two are deliberately NOT under `/api/`). W785 added
 * `GET /api/usage/ledger` (49 -> 50). W791 added
 * `POST /api/sessions/{id}/mode` (50 -> 51; the P1 session working mode). W9
 * added the six permission endpoints (51 -> 57). W860 added
 * `GET|PUT /api/sessions/{id}/tools` and `GET /api/plugins` (57 -> 60). W870
 * added `PUT /api/sessions/{id}/model` (60 -> 61; the statusline picker's
 * session-scoped model switch). G5 added `GET /api/fs/list` (61 -> 62; the
 * Win-style file manager's directory+file listing). G2 added `POST /api/exec`
 * (62 -> 63; immediate shell execution for the UI's /run and !, no model).
 * W1528 added `POST /api/terminal`, `POST /api/terminal/{id}/input` and
 * `POST /api/terminal/{id}/close` (66 -> 69; the workbench terminal's real-PTY
 * face — open / keystrokes / close). All of
 * them have NO counterpart in the legacy backend:
 * `contracts/route-table.snapshot.json` keeps the frozen extraction intact and
 * lists the TypeScript-only additions separately.
 */

import { loadEndpoints, type EndpointContract } from "@celestea/core";

export interface RegisteredRoute {
  id: string;
  method: "GET" | "POST" | "DELETE" | "PUT";
  /** Contract path, e.g. /api/sessions/{id}/messages */
  contractPath: string;
  /** Hono path, e.g. /api/sessions/:id/messages */
  honoPath: string;
  endpoint: EndpointContract;
}

export function toHonoPath(contractPath: string): string {
  return contractPath.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1").replace(/\{\*([A-Za-z_][A-Za-z0-9_]*)\}/g, "*");
}

/** Substitute placeholder values so a route can be exercised in tests. */
export function concretePath(contractPath: string, sample = "sample-ws%2Fsample-session"): string {
  return contractPath
    .replace(/\{\*([A-Za-z_][A-Za-z0-9_]*)\}/g, "sample/asset.js")
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => (name === "id" ? sample : `sample-${name}`));
}

export function studioRoutes(): RegisteredRoute[] {
  const c = loadEndpoints();
  return c.endpoints.map((e) => ({
    id: e.id,
    method: e.method,
    contractPath: e.path,
    honoPath: toHonoPath(e.path),
    endpoint: e,
  }));
}

export const API_ENDPOINT_COUNT = 69;
export const STATIC_ROUTE_COUNT = 4;

/** Id-keyed view of the contract routes: a handler asks for its id, never a path. */
export interface RouteTable {
  routes: RegisteredRoute[];
  /** Throws when the id is not in the frozen contract (typo guard). */
  get(id: string): RegisteredRoute;
}

export function routeTable(): RouteTable {
  const routes = studioRoutes();
  const byId = new Map(routes.map((r) => [r.id, r]));
  return {
    routes,
    get(id: string): RegisteredRoute {
      const route = byId.get(id);
      if (route === undefined) throw new Error(`unknown contract endpoint id '${id}'`);
      return route;
    },
  };
}
