/**
 * W895-C1 / W9108: the DISPLAY COMPONENTS table — the server-side source of truth
 * that replaces the browser localStorage preference (W859).
 *
 * The stored value mirrors the old key for the ENABLED list: a `disabled: string[]`
 * of ids the user switched OFF. Storing the DISABLED set (not the enabled set) is
 * what keeps the product semantic "a newly added built-in component defaults to
 * ON" — an old file simply does not mention it.
 *
 * W9108 adds `config`: a per-plugin map of adjustable settings
 * (`{ [pluginId]: { [itemKey]: string } }`). The server stores it **opaquely**:
 * it normalizes keys/values to non-empty strings and never invents a plugin id or
 * an item key — knowing which plugins exist (and which items they have) is the
 * frontend's job, exactly like the disabled list. Values are strings so the JSON
 * round-trip has no type ambiguity (booleans are 'on'/'off').
 *
 * Same discipline as `store/session-tools.ts`: whitelist + validate, atomic
 * write, and a corrupt / foreign file means "nothing is disabled" (all display
 * components ON) — never "repair it".
 */

import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";

/** The data file, beside workspaces.json / providers.json / prompts.json. */
export const DISPLAY_PLUGINS_FILE = "display-plugins.json";

/** A plugin's saved settings: item key -> string value. */
export type PluginConfigValues = Record<string, string>;
/** Every plugin's saved settings: plugin id -> values. */
export type PluginConfigMap = Record<string, PluginConfigValues>;

export interface DisplayPluginsRead {
  /** The normalized disabled ids; empty whenever the file is absent or void. */
  disabled: string[];
  /** W9108: the normalized per-plugin settings (empty when the file has none). */
  config: PluginConfigMap;
  /**
   * Why the file was ignored. At most one entry, and it always says every
   * display component is enabled (the same "degrade + say so" contract as
   * `readSessionTools`).
   */
  warnings: string[];
}

/**
 * The ONE normalizer for the disabled list: trim, drop blanks, dedupe, keep
 * first-occurrence order. The PUT endpoint validates the raw array first (a
 * non-string or blank is a 422); a hand-written file goes through the same
 * function on read, where a blank entry is merely dropped.
 */
export function normalizeDisabledPlugins(disabled: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of disabled) {
    const id = value.trim();
    if (id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** Drop empty keys/values and plugins whose settings became empty. */
function normalizeConfig(config: PluginConfigMap): PluginConfigMap {
  const out: PluginConfigMap = {};
  for (const [id, values] of Object.entries(config)) {
    const pid = id.trim();
    if (pid === "") continue;
    const entry: PluginConfigValues = {};
    for (const [key, value] of Object.entries(values)) {
      const k = key.trim();
      if (k === "" || typeof value !== "string") continue;
      const v = value.trim();
      if (v === "") continue;
      entry[k] = v;
    }
    if (Object.keys(entry).length > 0) out[pid] = entry;
  }
  return out;
}

/**
 * W9108: the ONE normalizer for the settings map (pure; exported for tests).
 * Non-string / blank values are dropped rather than rejected — the file is
 * hand-editable and a stray blank must not take the whole table down.
 */
export function normalizePluginConfig(config: unknown): PluginConfigMap {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  const shaped: PluginConfigMap = {};
  for (const [id, values] of Object.entries(source)) {
    if (values === null || typeof values !== "object" || Array.isArray(values)) continue;
    const entry: PluginConfigValues = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value === "string") entry[key] = value;
    }
    shaped[id] = entry;
  }
  return normalizeConfig(shaped);
}

/**
 * Read + validate; NEVER throws. A missing file is `{disabled: [], config: {}}`
 * with no warning (the pre-W895 bytes); a broken one is the empty table plus ONE
 * warning that states every component is enabled.
 */
export function readDisplayPlugins(dir: string): DisplayPluginsRead {
  const out = readJsonIfExists(join(dir, DISPLAY_PLUGINS_FILE));
  if (!out.exists) return { disabled: [], config: {}, warnings: [] };
  const voided = (reason: string): DisplayPluginsRead => ({
    disabled: [],
    config: {},
    warnings: ["display_plugins_unreadable: " + reason + " — every display component is enabled"],
  });
  if (out.error !== undefined) return voided("unparsable display-plugins.json: " + out.error);
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return voided("display-plugins.json is not an object");
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return voided("unknown display-plugins.json version " + JSON.stringify(rec["version"]));
  const raw = rec["disabled"];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return voided("display-plugins.json has no `disabled` array of strings");
  }
  // W9108: `config` is OPTIONAL. A v1 file written before W9108 simply has no
  // key here and reads back as "no plugin is configured" — never a warning.
  return { disabled: normalizeDisabledPlugins(raw as string[]), config: normalizePluginConfig(rec["config"]), warnings: [] };
}

/** Normalize + atomic write; returns what was persisted. */
export function writeDisplayPlugins(
  dir: string,
  disabled: readonly string[],
  config: PluginConfigMap,
  now: number,
): { disabled: string[]; config: PluginConfigMap } {
  const normalizedDisabled = normalizeDisabledPlugins(disabled);
  const normalizedConfig = normalizePluginConfig(config);
  writeJsonAtomic(
    join(dir, DISPLAY_PLUGINS_FILE),
    { version: 1, disabled: normalizedDisabled, config: normalizedConfig, updated_at: now },
    { mode: 0o644 },
  );
  return { disabled: normalizedDisabled, config: normalizedConfig };
}
