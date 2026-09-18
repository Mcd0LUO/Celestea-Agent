/**
 * Permission presets (W9) - the built-in constants and the two files.
 *
 * Model (design approved by the architect):
 *   - built-in presets read-only / write-read / full-access are CODE constants;
 *   - custom presets live at <data dir>/permissions.json (atomic 0600);
 *   - a session's chosen preset lives at <session dir>/permission.json, a file
 *     PARALLEL to grants.json (whose v1 shape is deliberately untouched).
 *
 * Same discipline as grants.json: whitelist + validate every field, and a
 * corrupt file means "fall back to the default", never "repair it". A permission
 * is a BASELINE: engine-grants.ts intersects grants into it and a grant can
 * never widen past it.
 */

import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";

export const PERMISSIONS_FILE = "permissions.json";
export const SESSION_PERMISSION_FILE = "permission.json";
export const ENV_PERMISSION_DEFAULT = "CELESTEA_PERMISSION_DEFAULT";
export const ENV_PERMISSION_MAX = "CELESTEA_PERMISSION_MAX";
export const DEFAULT_PERMISSION_ID = "full-access";
export const MAX_PRESET_ROOTS = 32;
export const MAX_PRESET_TOOLS = 64;
export const MAX_PRESET_LABEL_CHARS = 80;

export const BUILTIN_PRESET_IDS = ["read-only", "write-read", "full-access"] as const;
export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

export interface PermissionPreset {
  id: string;
  label: string;
  network: boolean;
  workspaceWritable: boolean;
  /** The deployment CELESTEA_TOOL_ROOTS (repo/harness/tmp) become writable. */
  toolRootsWritable: boolean;
  /** Explicit absolute extra write roots, besides workspace + tool roots. */
  writeRoots: string[];
  /**
   * W864: the whole filesystem is readable AND writable ("/" as the one root).
   * Path-only: network / unsandboxed / toolDeny are untouched by it.
   */
  allPaths: boolean;
  unsandboxed: boolean;
  /** Tools removed from the session face (baseline filter, before tool_extra). */
  toolDeny: string[];
}

export const BUILTIN_PRESETS: readonly PermissionPreset[] = [
  { id: "read-only", label: "Read only", network: false, workspaceWritable: false, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: ["write_file"] },
  { id: "write-read", label: "Write + read (workspace)", network: false, workspaceWritable: true, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: [] },
  { id: "full-access", label: "Full access", network: true, workspaceWritable: true, toolRootsWritable: true, writeRoots: [], allPaths: true, unsandboxed: true, toolDeny: [] },
];

export function isBuiltinPresetId(id: string): id is BuiltinPresetId {
  return (BUILTIN_PRESET_IDS as readonly string[]).includes(id);
}

export function builtinPreset(id: string): PermissionPreset | null {
  for (const preset of BUILTIN_PRESETS) if (preset.id === id) return preset;
  return null;
}

export function defaultPermissionId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[ENV_PERMISSION_DEFAULT] ?? "").trim();
  return raw === "" ? DEFAULT_PERMISSION_ID : raw;
}

export function maxPermissionId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[ENV_PERMISSION_MAX] ?? "").trim();
  return raw === "" ? DEFAULT_PERMISSION_ID : raw;
}

export interface PermissionsRead {
  presets: PermissionPreset[];
  warnings: string[];
}

export function readPermissionsFile(dataDir: string): PermissionsRead {
  const out = readJsonIfExists(join(dataDir, PERMISSIONS_FILE));
  if (!out.exists) return { presets: [], warnings: [] };
  if (out.error !== undefined) return { presets: [], warnings: ["permissions_unreadable: " + out.error] };
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { presets: [], warnings: ["permissions.json is not an object"] };
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return { presets: [], warnings: ["unknown permissions.json version " + JSON.stringify(rec["version"])] };
  if (!Array.isArray(rec["presets"])) return { presets: [], warnings: ["permissions.json has no presets array"] };
  const presets: PermissionPreset[] = [];
  for (const raw of rec["presets"]) {
    const parsed = parsePreset(raw);
    if (parsed !== null && !isBuiltinPresetId(parsed.id)) presets.push(parsed);
  }
  return { presets, warnings: [] };
}

export function writePermissionsFile(dataDir: string, presets: readonly PermissionPreset[], now: number): void {
  writeJsonAtomic(join(dataDir, PERMISSIONS_FILE), { version: 1, updated_at: now, presets: presets.map(sanitizePreset) }, { mode: 0o600 });
}

function stringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") continue;
    out.push(value.trim());
    if (out.length >= max) break;
  }
  return [...new Set(out)];
}

export function parsePreset(raw: unknown): PermissionPreset | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = rec["id"];
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) return null;
  const label = typeof rec["label"] === "string" ? rec["label"].slice(0, MAX_PRESET_LABEL_CHARS) : id;
  return {
    id,
    label,
    network: rec["network"] === true,
    workspaceWritable: rec["workspaceWritable"] === true,
    toolRootsWritable: rec["toolRootsWritable"] === true,
    writeRoots: stringArray(rec["writeRoots"], MAX_PRESET_ROOTS),
    allPaths: rec["allPaths"] === true,
    unsandboxed: rec["unsandboxed"] === true,
    toolDeny: stringArray(rec["toolDeny"], MAX_PRESET_TOOLS),
  };
}

function sanitizePreset(preset: PermissionPreset): PermissionPreset {
  return {
    id: preset.id,
    label: preset.label.slice(0, MAX_PRESET_LABEL_CHARS),
    network: preset.network === true,
    workspaceWritable: preset.workspaceWritable === true,
    toolRootsWritable: preset.toolRootsWritable === true,
    writeRoots: stringArray(preset.writeRoots, MAX_PRESET_ROOTS),
    allPaths: preset.allPaths === true,
    unsandboxed: preset.unsandboxed === true,
    toolDeny: stringArray(preset.toolDeny, MAX_PRESET_TOOLS),
  };
}


export interface SessionPermissionRead {
  exists: boolean;
  preset?: string;
  error?: string;
}

export function readSessionPermission(dir: string, expectedSession: string): SessionPermissionRead {
  const out = readJsonIfExists(join(dir, SESSION_PERMISSION_FILE));
  if (!out.exists) return { exists: false };
  if (out.error !== undefined) return { exists: true, error: "unparsable permission.json: " + out.error };
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { exists: true, error: "permission.json is not an object" };
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return { exists: true, error: "unknown permission.json version " + JSON.stringify(rec["version"]) };
  if (rec["session"] !== expectedSession) return { exists: true, error: "permission.json belongs to " + JSON.stringify(rec["session"]) };
  if (typeof rec["preset"] !== "string" || rec["preset"] === "") return { exists: true, error: "permission.json has no preset" };
  return { exists: true, preset: rec["preset"] };
}

export function writeSessionPermission(dir: string, session: string, preset: string, now: number): void {
  writeJsonAtomic(join(dir, SESSION_PERMISSION_FILE), { version: 1, session, preset, updated_at: now }, { mode: 0o600 });
}
