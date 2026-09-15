/**
 * The two user-question endpoints (W783 §9 item 7).
 *
 *   GET  /api/questions                  → every question still answerable
 *   POST /api/questions/{id}/answer      → the human's answer
 *
 * WHY THE ANSWER IS NOT `POST /api/turn`: while the model's `ask_user_question`
 * call is parked, the session's turn slot is occupied. A message posted to
 * `/api/turn` is therefore accepted as STEERING, and steering is only drained at
 * a step boundary — a boundary the parked call never reaches (§2.2). Sending the
 * answer here instead resolves the pending promise the tool is awaiting, so the
 * tool wakes with an ordinary result and the turn continues (§4.2).
 *
 * The `GET` exists for §7 recovery: the `question` SSE frame can be missed (a
 * reload, a dropped connection), so the list is the authoritative rebuild source.
 * Every timing field is judged at READ time, so the client never trusts its own
 * clock and a long-disconnected tab cannot resurrect an expired question.
 */

import type { Hono } from "hono";
import type { AskUserQuestionAnswerItem } from "@celestea/core";
import { errText } from "../store/result.js";
import type { RouteTable } from "../routes.js";
import { failJson, readJsonBody, strField, type Deps, type JsonObject } from "./common.js";

/** One answer as the request body carries it. */
type AnswerRead = { ok: true; answers: AskUserQuestionAnswerItem[] } | { ok: false; error: string };

/** Read `answers`: every entry needs a string `id`, a string[] `selected` (optional `custom`). */
function readAnswers(body: JsonObject): AnswerRead {
  const raw = body["answers"];
  if (!Array.isArray(raw)) return { ok: false, error: "field 'answers' must be an array" };
  const out: AskUserQuestionAnswerItem[] = [];
  for (const item of raw) {
    const parsed = readAnswer(item);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    out.push(parsed);
  }
  return { ok: true, answers: out };
}

/** One answer entry, or the reason it is malformed. */
function readAnswer(item: unknown): AskUserQuestionAnswerItem | string {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return "each answer must be an object {id,selected[],custom?}";
  const record = item as Record<string, unknown>;
  if (typeof record["id"] !== "string") return "each answer needs a string 'id'";
  const selected = record["selected"];
  if (!Array.isArray(selected) || selected.some((value) => typeof value !== "string")) {
    return `answer '${record["id"]}' needs 'selected' as an array of strings (option LABELS, never indices)`;
  }
  const custom = record["custom"];
  if (custom !== undefined && custom !== null && typeof custom !== "string") {
    return `answer '${record["id"]}' has a non-string 'custom'`;
  }
  const answer: AskUserQuestionAnswerItem = { id: record["id"], selected: selected as string[] };
  if (typeof custom === "string") answer.custom = custom;
  return answer;
}

/** POST /api/questions/{id}/answer — resolve the parked tool call (§4.2). */
function registerAnswer(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_question_answer");
  app.on(route.method, route.honoPath, async (c) => {
    const requestId = c.req.param("id") ?? "";
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const answers = readAnswers(read.body);
    if (!answers.ok) return failJson(c, 422, answers.error);
    // Optional guard: a stale tab must not answer another session's question by
    // guessing an id (the id alone is not an authorization).
    const guard = strField(c, read.body, "session");
    if (!guard.ok) return guard.response;
    const answer = deps.runtime.answerQuestion;
    if (answer === undefined) return failJson(c, 404, `unknown or already settled question '${requestId}'`);
    const outcome = answer.call(deps.runtime, requestId, answers.answers, guard.value);
    if (!outcome.ok) return refuse(c, requestId, outcome.reason);
    // `timed_out:false` is a fact, not a placeholder: a REAL answer arrived, so
    // the §6.2 race is resolved in the user's favour (whoever arrives first wins).
    return c.json({ ok: true, id: requestId, session: outcome.session, timed_out: false });
  });
  return route.id;
}

/** The refusal status of one answer attempt (never a silent 200). */
function refuse(c: Parameters<typeof failJson>[0], requestId: string, reason: string): Response {
  if (reason === "mismatch") return failJson(c, 409, `question '${requestId}' was asked by another session`);
  if (reason === "timed_out" || reason === "settled") {
    return failJson(c, 409, `question '${requestId}' already settled`, { timed_out: reason === "timed_out" });
  }
  return failJson(c, 404, `unknown or already settled question '${requestId}'`);
}

/** GET /api/questions — the §7 recovery list (pending questions only). */
function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_questions");
  app.on(route.method, route.honoPath, (c) => {
    const asked = (c.req.query("session") ?? "").trim();
    const pending = deps.runtime.pendingQuestions;
    if (pending === undefined) return c.json({ ok: true, questions: [] });
    try {
      // An ABSENT filter is not the same as filtering by `null`: the latter would
      // return only the detached generation's questions. Passing `undefined`
      // keeps the whole table, which is what a reconnecting client needs.
      return c.json({ ok: true, questions: pending.call(deps.runtime, asked === "" ? undefined : asked) });
    } catch (e) {
      return failJson(c, 500, errText(e));
    }
  });
  return route.id;
}

/** The two question routes, in contract order. */
export function registerQuestions(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerList(app, deps, table), registerAnswer(app, deps, table)];
}
