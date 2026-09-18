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

import { join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { TurnBusyError } from "@celestea/runtime";
import { ATTACHMENTS_DIRNAME, createAttachmentStore } from "@celestea/tools";
import type { ImageRef } from "@celestea/core";
import { CapacityError, type TurnDeliveryMode } from "../runtime-adapter.js";
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

/** W804: the inline attachments one POST /api/turn may carry (section 7.4 P0). */
const MAX_TURN_ATTACHMENTS = 20;

/**
 * Decode the optional inline base64 `attachments` and store them under
 * `<session-dir>/attachments/`. P0 adds NO upload endpoint: the bytes ride the
 * turn body and the session log only ever sees the returned references.
 */
async function storeTurnAttachments(
  c: Parameters<typeof failJson>[0],
  deps: Deps,
  session: string | null,
  raw: unknown,
): Promise<{ ok: true; refs: ImageRef[] } | { ok: false; response: Response }> {
  if (raw === undefined || raw === null) return { ok: true, refs: [] };
  if (!Array.isArray(raw)) return { ok: false, response: errorOnly(c, 400, "attachments must be an array") };
  if (raw.length === 0) return { ok: true, refs: [] };
  if (raw.length > MAX_TURN_ATTACHMENTS) {
    return { ok: false, response: errorOnly(c, 400, `too many attachments (max ${MAX_TURN_ATTACHMENTS})`) };
  }
  const resolved = session === null ? null : deps.sessions.resolve(session);
  const dir = resolved !== null && resolved.ok ? resolved.value.dir : null;
  if (dir === null) return { ok: false, response: errorOnly(c, 400, "attachments require a resolvable session directory") };
  const store = createAttachmentStore(join(dir, ATTACHMENTS_DIRNAME));
  const refs: ImageRef[] = [];
  for (const item of raw) {
    const rec = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const data = rec["data"];
    const name = typeof rec["name"] === "string" ? rec["name"] : undefined;
    if (typeof data !== "string" || data.trim() === "") {
      return { ok: false, response: errorOnly(c, 400, "each attachment needs a non-empty base64 data string") };
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return { ok: false, response: errorOnly(c, 400, "attachment data decoded to zero bytes") };
    try {
      refs.push(await store.put({ bytes, ...(name === undefined ? {} : { name }) }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, response: errorOnly(c, 400, `attachment rejected: ${message}`) };
    }
  }
  return { ok: true, refs };
}

function registerTurn(app: Hono, deps: Deps, table: RouteTable): string {
  const turn = table.get("post_turn");
  app.on(turn.method, turn.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const input = strField(c, read.body, "input");
    const asked = strField(c, read.body, "session");
    for (const field of [input, asked]) if (!field.ok) return field.response;
    // W847: resolve + validate the delivery lane BEFORE anything is written, so
    // an illegal mode never leaves an attachment (or a stored turn) behind. An
    // omitted mode is "steer" — byte-identical to the pre-W847 request.
    const requestedMode = read.body["mode"];
    if (requestedMode !== undefined && requestedMode !== null && requestedMode !== "steer" && requestedMode !== "queue") {
      return failJson(c, 400, 'invalid mode: ' + String(requestedMode) + ' (expected "steer" or "queue")');
    }
    const mode: TurnDeliveryMode = requestedMode === "queue" ? "queue" : "steer";
    const text = (input.ok ? (input.value ?? "") : "").trim();
    const target = turnTarget(c, deps, asked.ok ? asked.value : undefined);
    if (!target.ok) return storeFail(c, target);
    const session = target.value;
    // W804: decode + store the optional inline image attachments BEFORE the
    // empty-input check — a turn may legitimately carry images and no text.
    // W815-4: a busy session REFUSES image attachments (steering lanes carry
    // text only), so refuse BEFORE `storeTurnAttachments` writes anything under
    // <session>/attachments/ — the old order wrote up to 20 * 4 MiB and only then
    // 409'd, leaking every byte for a turn that was never started.
    const rawAttachments = read.body["attachments"];
    if (deps.runtime.isBusy(session) && Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      return busyAttachmentError(c);
    }
    const stored = await storeTurnAttachments(c, deps, session, rawAttachments);
    if (!stored.ok) return stored.response;
    const attachments = stored.refs;
    if (text === "" && attachments.length === 0) return errorOnly(c, 400, "input must not be empty");
    if (deps.runtime.isBusy(session)) {
      // W513 steering lanes carry TEXT only: an image must never be silently
      // dropped, so a busy session refuses rather than pretends.
      if (attachments.length > 0) return busyAttachmentError(c);
      return injectInto(c, deps, text, session, mode);
    }
    try {
      const started = await deps.runtime.startTurn({
        input: text,
        session,
        ...(attachments.length === 0 ? {} : { attachments }),
      });
      // W515 §2: the turn's own input IS the context the model sees first.
      return c.json({ turn: started.turn, status: "started", placement: started.placement ?? "context" }, 202);
    } catch (e) {
      if (e instanceof TurnBusyError) {
        if (attachments.length > 0) return busyAttachmentError(c);
        return injectInto(c, deps, text, session, mode);
      }
      if (e instanceof CapacityError) return capacityJson(c, e);
      return failJson(c, 500, e instanceof Error ? e.message : String(e));
    }
  });
  return turn.id;
}

/** W804: the running-turn refusal (steering cannot carry an image). */
function busyAttachmentError(c: Parameters<typeof failJson>[0]): Response {
  return failJson(c, 409, "attachments cannot be injected into a running turn; send them when the turn finishes");
}


/**
 * W513/W847: the session is busy -> the input joins a lane. `mode` = "steer"
 * injects into the RUNNING turn at its next step boundary; "queue" parks it for
 * the next turn start. The response shape is unchanged (the caller reads
 * `placement`, not `injected`, to render the terminal state).
 */
function injectInto(c: Parameters<typeof failJson>[0], deps: Deps, text: string, session: string | null, mode: TurnDeliveryMode): Response {
  const out = deps.runtime.inject({ input: text, session, mode });
  return c.json({ ok: true, injected: out.injected, turn: out.turn, pending: out.pending, placement: out.placement, duplicate: out.duplicate });
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
