/**
 * Dialog endpoints — `GET /api/events` (SSE), `POST /api/turn`,
 * `POST /api/cancel`, `POST /api/clear`
 * (`src/main.rs:871-1037`, `src/workspaces.rs:1500-1511`).
 *
 * `/api/turn` grabs the single-concurrency slot and returns 202 immediately;
 * everything else travels over SSE. `/api/events` never closes on overflow: a
 * slow subscriber gets ONE `status:lagged` frame and keeps consuming.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { TurnBusyError } from "../runtime-adapter.js";
import type { RouteTable } from "../routes.js";
import { activeSession, errorOnly, failJson, readJsonBody, strField, type Deps } from "./common.js";

function registerEvents(app: Hono, deps: Deps, table: RouteTable): string {
  const events = table.get("get_events");
  app.on(events.method, events.honoPath, (c) => {
    const response = streamSSE(c, async (stream) => {
      const sub = deps.bus.subscribe();
      stream.onAbort(() => sub.close());
      try {
        for (;;) {
          const frame = await sub.next();
          if (frame === null) break;
          await stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.envelope) });
        }
      } finally {
        sub.close();
      }
    });
    response.headers.set("cache-control", "no-cache");
    return response;
  });
  return events.id;
}

function registerTurn(app: Hono, deps: Deps, table: RouteTable): string {
  const turn = table.get("post_turn");
  app.on(turn.method, turn.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const input = strField(c, read.body, "input");
    if (!input.ok) return input.response;
    const text = (input.value ?? "").trim();
    if (text === "") return errorOnly(c, 400, "input must not be empty");
    // Busy-slot guard first (Rust `try_lock`); `startTurn` re-checks atomically.
    if (deps.runtime.isBusy()) return failJson(c, 409, "a turn is already running");
    try {
      const started = await deps.runtime.startTurn({ input: text, session: activeSession(deps) });
      return c.json({ turn: started.turn, status: "started" }, 202);
    } catch (e) {
      if (e instanceof TurnBusyError) return failJson(c, 409, "a turn is already running");
      return failJson(c, 500, e instanceof Error ? e.message : String(e));
    }
  });
  return turn.id;
}

function registerCancel(app: Hono, deps: Deps, table: RouteTable): string {
  const cancel = table.get("post_cancel");
  app.on(cancel.method, cancel.honoPath, (c) => c.json({ ok: true, cancelled: deps.runtime.cancel() }));
  return cancel.id;
}

function registerClear(app: Hono, deps: Deps, table: RouteTable): string {
  const clear = table.get("post_clear");
  app.on(clear.method, clear.honoPath, async (c) => {
    const session = activeSession(deps);
    await deps.runtime.clear(session);
    if (session !== null) {
      const resolved = deps.sessions.resolve(session);
      if (resolved.ok) deps.sessions.truncate(resolved.value);
    }
    return c.json({ ok: true, cleared: true, session });
  });
  return clear.id;
}

export function registerDialog(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerEvents(app, deps, table), registerTurn(app, deps, table), registerCancel(app, deps, table), registerClear(app, deps, table)];
}
