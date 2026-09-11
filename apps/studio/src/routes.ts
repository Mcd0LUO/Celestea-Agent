/**
 * Route table derived from the frozen contract.
 *
 * 43 API endpoints (47 method+path combos minus the 4 static routes).
 * Rust path params use `{id}`; Hono uses `:id`, so paths are translated here
 * once and the translation is asserted in tests.
 *
 * W516 added `GET|POST|DELETE /api/sessions/{id}/grants` and
 * `GET /api/sessions/{id}/grants/confirm-token` (39 -> 43). Those four have NO
 * Rust counterpart: `contracts/rust-route-table.snapshot.json` keeps the Rust
 * extraction intact and lists the TypeScript-only additions separately.
 */

import { loadEndpoints, type EndpointContract } from "@celestea/core";

export interface RegisteredRoute {
  id: string;
  method: "GET" | "POST" | "DELETE";
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

export const API_ENDPOINT_COUNT = 43;
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
