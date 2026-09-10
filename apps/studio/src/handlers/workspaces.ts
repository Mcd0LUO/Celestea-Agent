/**
 * Workspace registry endpoints — `src/workspaces.rs:790-966`.
 *
 * `POST /api/workspaces` registers a folder by absolute path (the key is the
 * folder basename and is never stored); `{name}/rename` really renames the
 * USER folder and returns the whole registry view; `{name}/delete` only
 * deregisters and never touches the folder.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { validateWorkspaceName } from "../store/session-id.js";
import { failJson, readJsonBody, strArrayField, strField, storeFail, type Deps } from "./common.js";

/** Busy guard: renaming a workspace that hosts the ACTIVE session re-composes. */
function activeInWorkspace(deps: Deps, name: string): boolean {
  const active = deps.workspaces.activeSession();
  return active !== null && active.split("/")[0] === name;
}

function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_workspaces");
  app.on(route.method, route.honoPath, (c) => c.json(deps.workspaces.view()));
  return route.id;
}

function registerCreate(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_workspaces");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const path = strField(c, read.body, "path");
    if (!path.ok) return path.response;
    const res = deps.workspaces.register(path.value ?? "");
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true, name: res.value });
  });
  return route.id;
}

function registerRename(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_workspace_rename");
  app.on(route.method, route.honoPath, async (c) => {
    const name = c.req.param("name") ?? "";
    if (activeInWorkspace(deps, name) && deps.runtime.isBusy()) {
      return failJson(c, 409, "turn in progress; rename applies between turns");
    }
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const newName = strField(c, read.body, "new_name");
    if (!newName.ok) return newName.response;
    const checked = validateWorkspaceName(newName.value ?? "");
    if (!checked.ok) return failJson(c, 400, checked.error);
    const res = deps.workspaces.renameWorkspace(name, checked.name);
    if (!res.ok) return storeFail(c, res);
    return c.json(deps.workspaces.view());
  });
  return route.id;
}

function registerDelete(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_workspace_delete");
  app.on(route.method, route.honoPath, (c) => {
    const res = deps.workspaces.deregister(c.req.param("name") ?? "");
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true });
  });
  return route.id;
}

function registerBatchDelete(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_workspaces_batch_delete");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const names = strArrayField(c, read.body, "names");
    if (!names.ok) return names.response;
    if (names.value === undefined) return failJson(c, 422, "field 'names' must be an array of strings");
    const out = deps.workspaces.batchDelete(names.value);
    return c.json({ ok: true, deleted: out.deleted, failed: out.failed });
  });
  return route.id;
}

export function registerWorkspaces(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerList(app, deps, table), registerCreate(app, deps, table), registerRename(app, deps, table), registerDelete(app, deps, table), registerBatchDelete(app, deps, table)];
}
