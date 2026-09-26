/** 
 * `POST /api/sessions/{id}/goal` — the session's PERSISTENT GOAL (A3, W9209).
 *
 * The frontend half shipped long ago (ui/commands/builtin.ts registers `/goal`,
 * ui/commands/goal.ts calls `api.setGoal`, statusline/goal.ts renders the badge,
 * types/goal.ts declares the wire shape) but the endpoint never existed, so every
 * `/goal` fell through to the `/api/*` 404 fallback and could never succeed.
 * This file is the missing half.
 *
 * ## Storage: `<session-dir>/goal.json`
 *
 *   `{ version: 1, session: "<workspace>/<session>", text, created_at, updated_at }`
 *
 * Deliberately NOT `session.json`: that file is a creation-time property bag whose
 * writer (store/session-meta.ts) drops every empty field and returns WITHOUT writing
 * when they are all empty — so a goal could never be CLEARED through it. A goal is
 * mutable state with a delete semantic, which is what a dedicated sidecar is for
 * (the grants.json / tools.json / permission.json precedent).
 *
 * ## Clear semantics
 *
 * `text: ""` (or whitespace-only) DELETES the file. Absence is the ONE
 * representation of "no goal", so there is no `text: ""` record to misread and no
 * second "empty" state to keep in sync. `created_at` is PRESERVED across a replace
 * (only `updated_at` moves), so "when was this goal set" survives an edit.
 *
 * ## Fail-safe read
 *
 * A missing file is `goal: null` with no warning; a corrupt / foreign /
 * unknown-version file is `goal: null` PLUS one `warnings[]` entry — never a
 * repair, never a crash (the discipline of store/grants.ts and store/session-tools.ts).
 *
 * ## Wire shape
 *
 * `{ ok, session, goal }` with `goal` either `null` or
 * `{ text, createdAt, updatedAt }`. The two timestamps are camelCase ISO-8601
 * strings because that is what the ALREADY-SHIPPED frontend reads
 * (ui/commands/goal.ts `normalize()` reads `r['createdAt']` / `r['updatedAt']`) and
 * `apps/web` is outside this change's file boundary. On disk they are epoch SECONDS,
 * like every other `updated_at` in this repo.
 *
 * ## Scope (deliberate) — and why there is NO busy guard
 *
 * This endpoint PERSISTS and ECHOES the goal. It does not inject it into the system
 * prompt: that would mean editing the prompt assembly (handlers/config-shape.ts), and
 * "the goal does not drive auto-continuation" is the frozen P0 product decision
 * (docs/archive/decisions/iteration-g-workbench.md §2). Because nothing about a
 * session's GENERATION changes here, no 409 guard is taken and no session instance is
 * invalidated — unlike PUT .../tools or PUT .../model, whose writes DO swap a generation.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { SerialQueue } from "../serial-queue.js";
import { readJsonIfExists, writeJsonAtomic } from "../store/fs-json.js";
import { nowSec } from "../store/grants-service.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

/** The sidecar file, beside session.json inside the session directory. */
export const GOAL_FILE = "goal.json";

/** One stored goal (epoch SECONDS; the wire view converts to ISO-8601). */
export interface GoalRecord {
  version: number;
  session: string;
  text: string;
  created_at: number;
  updated_at: number;
}

/** Read outcome: the goal (or null) plus why a file was ignored, if it was. */
export interface GoalRead {
  goal: GoalRecord | null;
  /** Set only when an EXISTING file was structurally unusable. */
  warning?: string;
}

/**
 * One queue per process: the write is a read-modify-write of `created_at`, so two
 * concurrent POSTs would otherwise interleave and lose the earlier timestamp (the
 * display-plugins precedent, handlers/display-plugins.ts).
 */
const writes = new SerialQueue();

function goalPath(dir: string): string {
  return join(dir, GOAL_FILE);
}

/**
 * Read + validate; NEVER throws. A missing file and a void file both answer "no
 * goal" — the difference is only whether a warning is reported.
 */
export function readGoal(dir: string, session: string): GoalRead {
  const out = readJsonIfExists(goalPath(dir));
  if (!out.exists) return { goal: null };
  const voided = (reason: string): GoalRead => ({ goal: null, warning: "goal_unreadable: " + reason });
  if (out.error !== undefined) return voided("unparsable goal.json: " + out.error);
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return voided("goal.json is not an object");
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return voided("unknown goal.json version " + JSON.stringify(rec["version"]));
  if (rec["session"] !== session) return voided("goal.json belongs to " + JSON.stringify(rec["session"]));
  const text = rec["text"];
  if (typeof text !== "string" || text === "") return voided("goal.json has no non-empty text");
  const created = rec["created_at"];
  const updated = rec["updated_at"];
  if (typeof created !== "number" || typeof updated !== "number") return voided("goal.json has no numeric timestamps");
  return { goal: { version: 1, session, text, created_at: created, updated_at: updated } };
}

/** Delete the sidecar. Absence is the ONLY representation of "no goal". */
export function clearGoal(dir: string): void {
  rmSync(goalPath(dir), { force: true });
}

/**
 * Write the record; `created_at` is inherited from the goal being replaced so an
 * edit does not look like a brand-new goal.
 */
export function writeGoal(dir: string, session: string, text: string, now: number): void {
  const previous = readGoal(dir, session).goal;
  const record: GoalRecord = { version: 1, session, text, created_at: previous?.created_at ?? now, updated_at: now };
  writeJsonAtomic(goalPath(dir), record, { mode: 0o644 });
}

/** The wire view of one record (null = no goal). */
function goalView(record: GoalRecord | null): Record<string, unknown> | null {
  if (record === null) return null;
  return {
    text: record.text,
    createdAt: new Date(record.created_at * 1000).toISOString(),
    updatedAt: new Date(record.updated_at * 1000).toISOString(),
  };
}

/** `POST /api/sessions/{id}/goal` — set (`text` non-empty) or clear (`text: ""`). */
export function registerGoal(app: Hono, deps: Deps, table: RouteTable): string[] {
  const route = table.get("post_session_goal");
  app.on(route.method, route.honoPath, async (c) => {
    // `require` (not `resolve`): a goal needs a real session directory to live in,
    // so an id that names no session is the contract's 404 — and a `worker:<sid>` id
    // (no directory by construction) is rejected here as well.
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const session = resolved.value.id;
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const field = strField(c, body.body, "text");
    if (!field.ok) return field.response;
    if (field.value === undefined) return failJson(c, 422, "field 'text' must be a string");
    // Trimmed on the server too: the frontend already sends a trimmed value, so
    // this is a no-op on the UI path and normalization for an API caller. A
    // whitespace-only goal is indistinguishable from "clear" by design.
    const text = field.value.trim();
    const now = nowSec(deps.grants);
    try {
      const outcome = await writes.run(async (): Promise<GoalRead> => {
        if (text === "") {
          clearGoal(resolved.value.dir);
          return { goal: null };
        }
        writeGoal(resolved.value.dir, session, text, now);
        // Read back: the response states what is ON DISK, never what we meant to write.
        return readGoal(resolved.value.dir, session);
      });
      const warnings = outcome.warning === undefined ? [] : [outcome.warning];
      return c.json({
        ok: true,
        session,
        goal: goalView(outcome.goal),
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    } catch (e) {
      return failJson(c, 500, "cannot persist goal: " + errText(e));
    }
  });
  return [route.id];
}
