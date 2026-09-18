/**
 * The six permission endpoints (W9): custom-preset CRUD plus a session's chosen
 * preset. Storage and resolution live in store/permissions.ts and
 * runtime/engine-permissions.ts; this module is the HTTP face only.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { effectivePermissionOf, permissionDataDir, type PermissionBaseline } from "../runtime/engine-permissions.js";
import { validatePermissionPreset } from "../runtime/engine-grants.js";
import {
  BUILTIN_PRESETS,
  isBuiltinPresetId,
  maxPermissionId,
  readPermissionsFile,
  readSessionPermission,
  writePermissionsFile,
  writeSessionPermission,
  type PermissionPreset,
} from "../store/permissions.js";
import { nowSec } from "../store/grants-service.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

function presetBody(p: PermissionPreset): Record<string, unknown> {
  return {
    id: p.id,
    label: p.label,
    network: p.network,
    workspaceWritable: p.workspaceWritable,
    toolRootsWritable: p.toolRootsWritable,
    writeRoots: [...p.writeRoots],
    allPaths: p.allPaths,
    unsandboxed: p.unsandboxed,
    toolDeny: [...p.toolDeny],
  };
}

/** W864: the resolved baseline, as the two session-permission endpoints report it. */
function effectiveBody(b: PermissionBaseline): Record<string, unknown> {
  return {
    network: b.network,
    workspaceWritable: b.workspaceWritable,
    toolRootsWritable: b.toolRootsWritable,
    writeRoots: [...b.writeRoots],
    allPaths: b.allPaths,
    unsandboxed: b.unsandboxed,
    toolDeny: [...b.toolDeny],
  };
}

function registerListPresets(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_permissions_presets");
  app.on(route.method, route.honoPath, (c) => {
    const read = readPermissionsFile(permissionDataDir(deps.grants.env));
    return c.json({
      ok: true,
      builtin: BUILTIN_PRESETS.map(presetBody),
      custom: read.presets.map(presetBody),
      max: maxPermissionId(deps.grants.env),
      ...(read.warnings.length === 0 ? {} : { warnings: read.warnings }),
    });
  });
  return route.id;
}

function registerCreatePreset(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_permissions_presets");
  app.on(route.method, route.honoPath, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const dataDir = permissionDataDir(deps.grants.env);
    const read = readPermissionsFile(dataDir);
    const validated = validatePermissionPreset(body.body["preset"], deps.grants.env, read.presets.map((p) => p.id));
    if (!validated.ok) return failJson(c, validated.conflict === true ? 409 : 422, validated.error);
    try {
      writePermissionsFile(dataDir, [...read.presets, validated.preset], nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permissions: " + errText(e));
    }
    return c.json({ ok: true, preset: presetBody(validated.preset) });
  });
  return route.id;
}

function registerUpdatePreset(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_permissions_preset");
  app.on(route.method, route.honoPath, async (c) => {
    const id = c.req.param("id") ?? "";
    if (isBuiltinPresetId(id)) return failJson(c, 409, "'" + id + "' is a built-in preset");
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const dataDir = permissionDataDir(deps.grants.env);
    const read = readPermissionsFile(dataDir);
    if (!read.presets.some((p) => p.id === id)) return failJson(c, 404, "no custom preset '" + id + "'");
    const validated = validatePermissionPreset(body.body["preset"], deps.grants.env, []);
    if (!validated.ok) return failJson(c, 422, validated.error);
    if (validated.preset.id !== id) return failJson(c, 422, "preset id must not change (" + id + ")");
    const next = read.presets.map((p) => (p.id === id ? validated.preset : p));
    try {
      writePermissionsFile(dataDir, next, nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permissions: " + errText(e));
    }
    return c.json({ ok: true, preset: presetBody(validated.preset) });
  });
  return route.id;
}

function registerDeletePreset(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("delete_permissions_preset");
  app.on(route.method, route.honoPath, (c) => {
    const id = c.req.param("id") ?? "";
    if (isBuiltinPresetId(id)) return failJson(c, 409, "'" + id + "' is a built-in preset");
    const dataDir = permissionDataDir(deps.grants.env);
    const read = readPermissionsFile(dataDir);
    if (!read.presets.some((p) => p.id === id)) return failJson(c, 404, "no custom preset '" + id + "'");
    try {
      writePermissionsFile(dataDir, read.presets.filter((p) => p.id !== id), nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permissions: " + errText(e));
    }
    return c.json({ ok: true, deleted: id });
  });
  return route.id;
}

function registerGetSessionPermission(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_permission");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const read = readSessionPermission(resolved.value.dir, resolved.value.id);
    const baseline = effectivePermissionOf(resolved.value.dir, resolved.value.id, deps.grants.env);
    const warnings = [
      ...(read.error === undefined ? [] : [read.error]),
      ...baseline.warnings,
    ];
    return c.json({
      ok: true,
      session: resolved.value.id,
      preset: read.preset ?? baseline.preset,
      effective: effectiveBody(baseline),
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  });
  return route.id;
}

function registerPutSessionPermission(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_session_permission");
  app.on(route.method, route.honoPath, async (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const preset = strField(c, body.body, "preset");
    if (!preset.ok) return preset.response;
    if (preset.value === undefined || preset.value === "") return failJson(c, 422, "field 'preset' is required");
    const read = readPermissionsFile(permissionDataDir(deps.grants.env));
    if (!isBuiltinPresetId(preset.value) && !read.presets.some((p) => p.id === preset.value)) {
      return failJson(c, 422, "unknown preset '" + preset.value + "'");
    }
    try {
      writeSessionPermission(resolved.value.dir, resolved.value.id, preset.value, nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permission: " + errText(e));
    }
    // W9: recompose the session at the next boundary (same hook grants use).
    deps.runtime.invalidateSession?.(resolved.value.id);
    const baseline = effectivePermissionOf(resolved.value.dir, resolved.value.id, deps.grants.env);
    return c.json({ ok: true, preset: preset.value, effective: effectiveBody(baseline) });
  });
  return route.id;
}

export function registerPermissions(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [
    registerListPresets(app, deps, table),
    registerCreatePreset(app, deps, table),
    registerUpdatePreset(app, deps, table),
    registerDeletePreset(app, deps, table),
    registerGetSessionPermission(app, deps, table),
    registerPutSessionPermission(app, deps, table),
  ];
}
