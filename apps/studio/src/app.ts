/**
 * Hono application skeleton.
 *
 * P0 registers all 39 contract endpoints and implements only the read-only
 * health/status shape; every other handler returns a 501 that names the
 * contract id, so P4 cannot silently ship an endpoint the contract does not
 * describe. SSE keeps the frozen envelope + lagged semantics.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadSse, type Statusline } from "@celestea/core";
import { API_ENDPOINT_COUNT, studioRoutes, type RegisteredRoute } from "./routes.js";

export interface StudioAppOptions {
  model?: string;
  baseUrl?: string;
  bind?: string;
  /** Deterministic clock for tests. */
  now?: () => number;
}

export interface StudioApp {
  app: Hono;
  routes: RegisteredRoute[];
  notImplemented: (id: string) => Response;
}

const NAME = "celestea-studio";
/** bind is a CONSTANT in Rust: it does not follow STUDIO_BIND (src/main.rs:867). */
const DEFAULT_BIND = "127.0.0.1:3777";

function notImplementedResponse(id: string): Response {
  return Response.json({ ok: false, error: `not implemented in P0 skeleton: endpoint '${id}' (contract frozen, handler lands in P4)` }, { status: 501 });
}

export function createStudioApp(opts: StudioAppOptions = {}): StudioApp {
  const app = new Hono();
  const routes = studioRoutes();
  if (routes.length !== API_ENDPOINT_COUNT) {
    throw new Error(`expected ${API_ENDPOINT_COUNT} contract endpoints, got ${routes.length}`);
  }

  const model = opts.model ?? "unknown";
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:3001/v1";
  const bind = opts.bind ?? DEFAULT_BIND;

  const emptyStatusline = (): Statusline => ({
    model,
    reasoning_effort: null,
    steps: 0,
    tokens_per_sec: 0,
    context_usage: { used: 0, window: 1_000_000, ratio: 0, estimated: true, method: "session_event_chars" },
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache_read: 0,
      cache_hit_ratio: 0,
      reasoning_tokens: 0,
      total: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read: 0, cache_hit_ratio: 0, reasoning_tokens: 0 },
    },
  });

  const sse = loadSse();

  for (const r of routes) {
    if (r.id === "get_health") {
      app.on("GET", r.honoPath, (c) =>
        c.json({ ok: true, name: NAME, model, base_url: baseUrl, bind }),
      );
      continue;
    }
    if (r.id === "get_status") {
      app.on("GET", r.honoPath, (c) => c.json({ ...emptyStatusline(), session: null }));
      continue;
    }
    if (r.id === "get_events") {
      app.on("GET", r.honoPath, (c) =>
        streamSSE(c, async (stream) => {
          // P0: no engine is attached, so only the envelope contract is
          // exercised (comment keepalive every 2s, matching STATUS_TICK).
          stream.writeSSE({ event: "status", data: JSON.stringify({ turn: 0, seq: 0, payload: { phase: "start", statusline: emptyStatusline() } }) });
          let n = 1;
          for (;;) {
            await stream.sleep(2000);
            stream.writeSSE({ data: "", event: "keepalive" });
            n += 1;
            if (n > 1_000_000) break;
          }
        }),
      );
      continue;
    }
    const handler = (): Response => notImplementedResponse(r.id);
    app.on(r.method, r.honoPath, handler);
  }

  // Unknown /api/* must be a 404 JSON (get_static fallback contract).
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  return { app, routes, notImplemented: notImplementedResponse };
}
