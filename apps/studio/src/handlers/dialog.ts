/**
 * Dialog endpoints — `GET /api/events` (SSE), `POST /api/turn`,
 * `POST /api/cancel`, `POST /api/clear`.
 *
 * W513 session-scoped behaviour:
 *   - `/api/turn` targets `{session}` (default = active session) and NEVER 409s
 *     because of a busy session: a running turn takes the input as an
 *     interjection injected at its next step boundary, and the response says so
 *     (`{ok:true, injected:true, turn}`). A 409 survives only for the atomic
 *     re-check race, and only for the target session;
 *   - `/api/cancel` and `/api/clear` take the same optional `{session}`;
 *   - `/api/events` streams every session by default (the envelope carries
 *     `session`), and `?session=<id>` (repeatable) narrows the server side.
 *
 * `/api/turn` returns immediately; everything else travels over SSE. The SSE
 * stream never closes on overflow: a slow subscriber gets ONE `status:lagged`
 * frame (with the session and the dropped count) and keeps consuming.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CapacityError, TurnBusyError } from "../runtime-adapter.js";
import type { RouteTable } from "../routes.js";
import type { StoreResult } from "../store/result.js";
import { activeSession, capacityJson, errorOnly, failJson, readJsonBody, storeFail, strField, type Deps } from "./common.js";

function registerEvents(app: Hono, deps: Deps, table: RouteTable): string {
  const events = table.get("get_events");
  app.on(events.method, events.honoPath, (c) => {
    const asked = c.req.queries("session") ?? [];
    const response = streamSSE(c, async (stream) => {
      const sub = deps.bus.subscribe(asked.length === 0 ? {} : { sessions: asked });
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

/** The turn target: an explicit `{session}`, else the active session. */
function turnTarget(c: Parameters<typeof failJson>[0], deps: Deps, asked: string | undefined): StoreResult<string | null> {
  if (asked === undefined || asked === "") return { ok: true, value: activeSession(deps) };
  const required = deps.sessions.require(asked);
  if (!required.ok) return required;
  return { ok: true, value: required.value.id };
}

function registerTurn(app: Hono, deps: Deps, table: RouteTable): string {
  const turn = table.get("post_turn");
  app.on(turn.method, turn.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const input = strField(c, read.body, "input");
    const asked = strField(c, read.body, "session");
    for (const field of [input, asked]) if (!field.ok) return field.response;
    const text = (input.ok ? (input.value ?? "") : "").trim();
    if (text === "") return errorOnly(c, 400, "input must not be empty");
    const target = turnTarget(c, deps, asked.ok ? asked.value : undefined);
    if (!target.ok) return storeFail(c, target);
    const session = target.value;
    if (deps.runtime.isBusy(session)) return injectInto(c, deps, text, session);
    try {
      const started = await deps.runtime.startTurn({ input: text, session });
      return c.json({ turn: started.turn, status: "started" }, 202);
    } catch (e) {
      if (e instanceof TurnBusyError) return injectInto(c, deps, text, session);
      if (e instanceof CapacityError) return capacityJson(c, e);
      return failJson(c, 500, e instanceof Error ? e.message : String(e));
    }
  });
  return turn.id;
}

/** W513: the session is busy -> the input joins the RUNNING turn. */
function injectInto(c: Parameters<typeof failJson>[0], deps: Deps, text: string, session: string | null): Response {
  const out = deps.runtime.inject({ input: text, session });
  return c.json({ ok: true, injected: out.injected, turn: out.turn, pending: out.pending });
}

/** The optional `{session}` of the cancel/clear bodies (absent = active). */
type SessionBody = { ok: true; session: string | null } | { ok: false; response: Response };

async function bodySession(c: Parameters<typeof failJson>[0], deps: Deps): Promise<SessionBody> {
  const read = await readJsonBody(c, false);
  if (!read.ok) return { ok: false, response: read.response };
  const asked = strField(c, read.body, "session");
  if (!asked.ok) return { ok: false, response: asked.response };
  const target = turnTarget(c, deps, asked.value);
  if (!target.ok) return { ok: false, response: storeFail(c, target) };
  return { ok: true, session: target.value };
}

function registerCancel(app: Hono, deps: Deps, table: RouteTable): string {
  const cancel = table.get("post_cancel");
  app.on(cancel.method, cancel.honoPath, async (c) => {
    const target = await bodySession(c, deps);
    if (!target.ok) return target.response;
    return c.json({ ok: true, cancelled: deps.runtime.cancel(target.session) });
  });
  return cancel.id;
}

function registerClear(app: Hono, deps: Deps, table: RouteTable): string {
  const clear = table.get("post_clear");
  app.on(clear.method, clear.honoPath, async (c) => {
    const target = await bodySession(c, deps);
    if (!target.ok) return target.response;
    const session = target.session;
    try {
      await deps.runtime.clear(session);
    } catch (e) {
      if (e instanceof TurnBusyError) return failJson(c, 409, "a turn is already running");
      return failJson(c, 500, e instanceof Error ? e.message : String(e));
    }
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
