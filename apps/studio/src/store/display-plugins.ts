/**
 * W895-C1: the DISPLAY COMPONENTS enabled table — the server-side source of
 * truth that replaces the browser localStorage preference (W859).
 *
 * The stored value mirrors the old key EXACTLY: a `disabled: string[]` list of
 * ids the user switched OFF. Storing the DISABLED set (not the enabled set) is
 * what keeps the product semantic "a newly added built-in component defaults to
 * ON" — an old file simply does not mention it.
 *
 * Same discipline as `store/session-tools.ts`: whitelist + validate, atomic
 * write, and a corrupt / foreign file means "nothing is disabled" (all display
 * components ON) — never "repair it". The frontend is the layer that knows the
 * ids (labels/hints are its i18n), so this store only normalizes strings and
 * never invents an id.
 */

import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";

/** The data file, beside workspaces.json / providers.json / prompts.json. */
export const DISPLAY_PLUGINS_FILE = "display-plugins.json";

export interface DisplayPluginsRead {
  /** The normalized disabled ids; empty whenever the file is absent or void. */
  disabled: string[];
  /**
   * Why the file was ignored. At most one entry, and it always says every
   * display component is enabled (the same "degrade + say so" contract as
   * `readSessionTools`).
   */
  warnings: string[];
}

/**
 * The ONE normalizer: trim, drop blanks, dedupe, keep first-occurrence order.
 * The PUT endpoint validates the raw array first (a non-string or blank is a
 * 422); a hand-written file goes through the same function on read, where a
 * blank entry is merely dropped.
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

/**
 * Read + validate; NEVER throws. A missing file is `{disabled: []}` with no
 * warning (the pre-W895 bytes); a broken one is the empty disabled set plus ONE
 * warning that states every component is enabled.
 */
export function readDisplayPlugins(dir: string): DisplayPluginsRead {
  const out = readJsonIfExists(join(dir, DISPLAY_PLUGINS_FILE));
  if (!out.exists) return { disabled: [], warnings: [] };
  const voided = (reason: string): DisplayPluginsRead => ({
    disabled: [],
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
  return { disabled: normalizeDisabledPlugins(raw as string[]), warnings: [] };
}

/** Normalize + atomic write; returns the list that was persisted. */
export function writeDisplayPlugins(dir: string, disabled: readonly string[], now: number): string[] {
  const normalized = normalizeDisabledPlugins(disabled);
  writeJsonAtomic(join(dir, DISPLAY_PLUGINS_FILE), { version: 1, disabled: normalized, updated_at: now }, { mode: 0o644 });
  return normalized;
}
