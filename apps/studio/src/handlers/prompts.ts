/**
 * Prompt registry endpoints — `src/prompts.rs:714-875`.
 *
 * Scope resolution: `workspace` absent or blank = global; an unknown workspace
 * is 404. The three write endpoints share ONE order: 409 guard (nothing is
 * written) -> persist -> hot apply -> restore the previous file when the apply
 * fails, so a failed compose can never leave the registry ahead of the engine.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { EngineError } from "../runtime-adapter.js";
import type { PromptScope } from "../store/prompts.js";
import type { StoreResult } from "../store/result.js";
import { activePromptBinding, assembleSystemPromptFor } from "./config-shape.js";
import { failJson, readJsonBody, strField, storeFail, type Deps, type JsonObject } from "./common.js";

/** Scope resolution result: either the scope, or the 404 workspace name. */
interface ScopeOut {
  scope?: PromptScope;
  error?: string;
}

function resolveScope(deps: Deps, workspace: string | undefined): ScopeOut {
  const name = (workspace ?? "").trim();
  if (name === "") return { scope: deps.prompts.scopeGlobal() };
  const path = deps.workspaces.workspacePath(name);
  if (path === undefined) return { error: `unknown workspace '${name}'` };
  return { scope: deps.prompts.scopeWorkspace(name, path) };
}

/** 409 -> persist -> hot apply -> rollback; returns the success body. */
async function hotApply(deps: Deps, scope: PromptScope, mutate: () => StoreResult<unknown>): Promise<{ ok: true; body: JsonObject } | { ok: false; status: number; error: string }> {
  if (deps.runtime.isBusy()) return { ok: false, status: 409, error: "turn in progress; prompt applies between turns" };
  const snapshot = deps.prompts.snapshot(scope);
  const res = mutate();
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  try {
    await deps.runtime.configure({ system_prompt: assembleSystemPromptFor(deps) });
  } catch (e) {
    deps.prompts.restore(scope, snapshot);
    return { ok: false, status: 500, error: `compose failed: ${e instanceof EngineError ? e.message : String(e)}` };
  }
  return { ok: true, body: { ok: true, ...(res.value as JsonObject) } };
}

function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_prompts");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = resolveScope(deps, c.req.query("workspace"));
    if (resolved.scope === undefined) return failJson(c, 404, resolved.error ?? "unknown workspace");
    return c.json(deps.prompts.list(resolved.scope, activePromptBinding(deps)));
  });
  return route.id;
}

function registerUpsert(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_prompts");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const workspace = strField(c, read.body, "workspace");
    const id = strField(c, read.body, "id");
    const name = strField(c, read.body, "name");
    for (const f of [workspace, id, name]) if (!f.ok) return f.response;
    const resolved = resolveScope(deps, workspace.ok ? workspace.value : undefined);
    if (resolved.scope === undefined) return failJson(c, 404, resolved.error ?? "unknown workspace");
    const overrides = read.body["section_overrides"];
    const out = await hotApply(deps, resolved.scope, () =>
      deps.prompts.upsert(resolved.scope as PromptScope, {
        id: (id.ok ? id.value : "") ?? "",
        name: (name.ok ? name.value : "") ?? "",
        section_overrides: isStringMap(overrides) ? overrides : undefined,
        is_default: typeof read.body["is_default"] === "boolean" ? read.body["is_default"] : undefined,
      }),
    );
    if (!out.ok) return failJson(c, out.status, out.error);
    return c.json(out.body);
  });
  return route.id;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v as JsonObject).every((x) => typeof x === "string");
}

function registerScopedWrite(app: Hono, deps: Deps, table: RouteTable, id: "post_prompts_delete" | "post_prompts_default"): string {
  const route = table.get(id);
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c, false);
    if (!read.ok) return read.response;
    const workspace = strField(c, read.body, "workspace");
    if (!workspace.ok) return workspace.response;
    const resolved = resolveScope(deps, workspace.value);
    if (resolved.scope === undefined) return failJson(c, 404, resolved.error ?? "unknown workspace");
    const promptId = c.req.param("id") ?? "";
    const out = await hotApply(deps, resolved.scope, () =>
      id === "post_prompts_delete" ? deps.prompts.remove(resolved.scope as PromptScope, promptId) : deps.prompts.setDefault(resolved.scope as PromptScope, promptId),
    );
    if (!out.ok) return failJson(c, out.status, out.error);
    return c.json(out.body);
  });
  return route.id;
}

export function registerPrompts(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerList(app, deps, table), registerUpsert(app, deps, table), registerScopedWrite(app, deps, table, "post_prompts_delete"), registerScopedWrite(app, deps, table, "post_prompts_default")];
}
