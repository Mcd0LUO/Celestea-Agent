/**
 * effectivePermissionOf (W9) - the ONE reader of a session's permission
 * BASELINE. engine-grants.ts intersects grants into it.
 *
 * Resolution of the requested preset:
 *   1. the caller hint (worker sessions have no directory and carry it in meta);
 *   2. <session dir>/permission.json;
 *   3. CELESTEA_PERMISSION_DEFAULT (default "full-access").
 * The baseline capabilities are then CLAMPED by CELESTEA_PERMISSION_MAX
 * (default "full-access"). The operator env gate for "unsandboxed" is applied
 * by engine-grants.ts when it builds the final EffectiveGrants, so this module
 * never imports engine-grants (no cycle).
 */

import { dirname } from "node:path";
import { parseToolRoots } from "@celestea/tools";
import { loadStudioConfig } from "../config.js";
import {
  builtinPreset,
  defaultPermissionId,
  maxPermissionId,
  readPermissionsFile,
  readSessionPermission,
  type PermissionPreset,
} from "../store/permissions.js";

export interface PermissionBaseline {
  preset: string;
  network: boolean;
  workspaceWritable: boolean;
  toolRootsWritable: boolean;
  writeRoots: readonly string[];
  /** W864: the whole filesystem is readable + writable (never env-gated). */
  allPaths: boolean;
  /** The preset capability; the env gate is applied by engine-grants.ts. */
  unsandboxed: boolean;
  toolDeny: readonly string[];
  warnings: readonly string[];
}

/** The data dir of the studio (same one workspaces.json / auth secret use). */
export function permissionDataDir(env: NodeJS.ProcessEnv): string {
  return dirname(loadStudioConfig({ env }).paths.workspacesFile);
}

function presetById(id: string, custom: readonly PermissionPreset[]): PermissionPreset | null {
  const builtin = builtinPreset(id);
  if (builtin !== null) return builtin;
  for (const preset of custom) if (preset.id === id) return preset;
  return null;
}

/** Capability-wise clamp by the operator MAX preset (a grant/档 can only narrow). */
function clampByMax(preset: PermissionPreset, max: PermissionPreset): PermissionPreset {
  const writesAllowed = max.allPaths || max.workspaceWritable || max.toolRootsWritable || max.writeRoots.length > 0;
  return {
    id: preset.id,
    label: preset.label,
    network: preset.network && max.network,
    workspaceWritable: preset.workspaceWritable && max.workspaceWritable,
    toolRootsWritable: preset.toolRootsWritable && max.toolRootsWritable,
    writeRoots: writesAllowed ? preset.writeRoots.filter((root) => max.writeRoots.includes(root)) : [],
    allPaths: preset.allPaths && max.allPaths,
    unsandboxed: preset.unsandboxed && max.unsandboxed,
    toolDeny: [...new Set([...preset.toolDeny, ...max.toolDeny])],
  };
}

export function effectivePermissionOf(
  sessionDir: string | null,
  sessionId: string | null,
  env: NodeJS.ProcessEnv,
  presetHint?: string | null,
): PermissionBaseline {
  const warnings: string[] = [];
  const dataDir = permissionDataDir(env);
  const customRead = readPermissionsFile(dataDir);
  warnings.push(...customRead.warnings);
  const custom = customRead.presets;

  let requested: string | null = presetHint ?? null;
  // W878: the sidecar is self-describing — use the TRUSTED id, never a path
  // inference. A null id with a real directory degrades fail-closed.
  if (requested === null && sessionDir !== null && sessionId !== null) {
    const file = readSessionPermission(sessionDir, sessionId);
    if (file.error !== undefined) warnings.push("permission_unreadable: " + file.error);
    if (file.preset !== undefined) requested = file.preset;
  }
  if (requested === null || requested === "") requested = defaultPermissionId(env);

  const fallback = presetById(defaultPermissionId(env), custom) ?? builtinPreset("full-access")!;
  const max = presetById(maxPermissionId(env), custom) ?? builtinPreset("full-access")!;
  let preset = presetById(requested, custom);
  if (preset === null) {
    warnings.push("unknown permission preset " + JSON.stringify(requested) + " - using " + fallback.id);
    preset = fallback;
  }
  const clamped = clampByMax(preset, max);

  const writeRoots: string[] = [];
  if (clamped.toolRootsWritable) {
    for (const root of parseToolRoots(env["CELESTEA_TOOL_ROOTS"])) if (!writeRoots.includes(root)) writeRoots.push(root);
  }
  for (const root of clamped.writeRoots) if (!writeRoots.includes(root)) writeRoots.push(root);

  return {
    preset: clamped.id,
    network: clamped.network,
    workspaceWritable: clamped.workspaceWritable,
    toolRootsWritable: clamped.toolRootsWritable,
    writeRoots,
    allPaths: clamped.allPaths,
    unsandboxed: clamped.unsandboxed,
    toolDeny: clamped.toolDeny,
    warnings,
  };
}
