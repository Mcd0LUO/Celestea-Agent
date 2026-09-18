/**
 * W870: the session-level MODEL switch endpoint (1).
 *
 *   PUT /api/sessions/{id}/model -> rewrite `<session dir>/session.json.model`
 *                                   (key-preserving; `""` CLEARS the override)
 *                                   and invalidate THIS session so its next
 *                                   turn recomposes on the new model.
 *
 * Why the endpoint exists (the user-visible bug it fixes): the statusline badge
 * is `GET /api/status?session=<focus>` polled every 2s, and that answer's `model`
 * is the SESSION INSTANCE's profile — global base + `session.json.model`
 * (`runtime/session-compose.ts` `profileFor`). The W750 picker only wrote the
 * GLOBAL default (`POST /api/config`), so for a session carrying an override the
 * optimistic badge was bounced back by the next poll (「切换模型后几秒又弹回原状」).
 *
 * Product semantic (W870, deliberate): the statusline's picker switches the
 * FOCUSED SESSION's model — it sits on that session's statusline, so that is what
 * the user means. The GLOBAL default stays `POST /api/config` and belongs to the
 * settings page. This endpoint is the session-scoped half.
 *
 * Disciplines, all inherited from the endpoints next to it:
 *   - the write path is W729's `session.json` writer (title / mode / prompt are
 *     kept), so a switch is the SAME operation `POST /api/sessions {model}` performs;
 *   - the busy guard is `/compact` and `POST /api/sessions/{id}/mode`'s: 409 while
 *     THIS session's turn runs, because a half-applied switch (this turn on the old
 *     model, the next on the new one) is exactly the silent surprise W870 removes;
 *   - the effect is W516's `invalidateSession`, the same next-turn-boundary hook
 *     `PUT /api/sessions/{id}/tools` and `PUT /api/sessions/{id}/permission` use.
 *     Sessions other than this one are untouched.
 *
 * The response echoes the RESOLVED value (`model` = override ?? global default)
 * plus `covered` / `effective.source`, so the client never has to guess whether an
 * override is in force — that is what the picker's 「本会话已固定模型」 hint reads.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { readSessionMeta, writeSessionMeta } from "../store/session-meta.js";
import { errText } from "../store/result.js";
import { validateModelName } from "../store/validate.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

/** The frozen response body (one shape, one construction).
 *
 * `model` is the model this session will run next turn; `covered` says whether
 * that comes from the session's OWN `session.json.model` (`effective.source`
 * `"session"`) or from the global default (`"global"`, i.e. no override).
 */
function sessionModelBody(deps: Deps, session: string, dir: string): Record<string, unknown> {
  const override = (readSessionMeta(dir)?.model ?? "").trim();
  const covered = override !== "";
  const base = deps.runtime.profile().model;
  return {
    ok: true,
    session,
    model: covered ? override : base,
    covered,
    effective: { model: covered ? override : base, base_model: base, source: covered ? "session" : "global", next_turn: true },
  };
}

export function registerSessionModel(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_session_model");
  app.on(route.method, route.honoPath, async (c) => {
    // W815-5: resolve to the CANONICAL id BEFORE the busy guard (`require` trims
    // and sanitizes the raw path segment, so a `%2F`-encoded id would otherwise
    // never match the canonical instance and the guard could be bypassed).
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const session = resolved.value.id;
    if (deps.runtime.isBusy(session)) return failJson(c, 409, "turn 进行中，无法切换模型");
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const model = strField(c, read.body, "model");
    if (!model.ok) return model.response;
    if (model.value === undefined) return failJson(c, 422, "field 'model' must be a string");
    const asked = model.value.trim();
    // `""` (or whitespace) is the documented CLEAR: the session falls back to the
    // global default. Anything else has to be a legal model id.
    if (asked !== "") {
      const bad = validateModelName(asked);
      if (bad !== null) return failJson(c, 400, bad);
    }
    try {
      // W729 write path, key-preserving: title / mode / prompt survive the switch.
      // An empty model DROPS the key (K8: absent = no override) instead of writing
      // `"model": ""` — the composer's `sessionModel` hook reads the absent key as
      // 「no override」 exactly like the empty string.
      const meta = readSessionMeta(resolved.value.dir) ?? {};
      if (asked === "") delete meta.model;
      else meta.model = asked;
      writeSessionMeta(resolved.value.dir, meta);
    } catch (e) {
      return failJson(c, 500, `meta write failed: ${errText(e)}`);
    }
    // W516/W860: recompose THIS session at its next boundary (nothing else is touched).
    deps.runtime.invalidateSession?.(session);
    return c.json(sessionModelBody(deps, session, resolved.value.dir));
  });
  return route.id;
}
