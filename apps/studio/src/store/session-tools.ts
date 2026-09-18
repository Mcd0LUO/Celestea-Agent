/**
 * W860: session-level TOOL SWITCHES — the pure SUBTRACTIVE layer beside the W9
 * permission baseline.
 *
 * A session may DISABLE tools by name (`<session dir>/tools.json`). The list is
 * a DENY set ONLY: `engine-grants.ts` unions it with the preset's `toolDeny`
 * (preset first, session second) into the session's effective deny, so the engine
 * can never turn a blocked name back on — including the names the `execution`
 * mode folded away. Nothing here ever ADDS a tool (grants' `tool_extra` is the
 * only additive path, and it is unaffected by this file).
 *
 * Same discipline as permission.json: whitelist + validate every field, atomic
 * 0600 write, and a corrupt / foreign file means "run as if nothing were
 * disabled" — never "repair it". That is deliberately fail-closed for the DENY
 * side: an unreadable list must never silently WIDEN the tool face.
 */

import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";

export const SESSION_TOOLS_FILE = "tools.json";

export interface SessionToolsRead {
  /** The normalized disabled list; empty whenever the file is absent or void. */
  disabled: string[];
  /**
   * Why the file was ignored. At most one entry, and it always says the session
   * runs with nothing disabled (the same "degrade + say so" contract as
   * `readSessionPermission`).
   */
  warnings: string[];
}

/**
 * Read + validate; NEVER throws. A missing file is `{disabled: []}` with no
 * warning (the pre-W860 bytes); a broken one is the empty deny set plus ONE
 * warning that states the session runs with no tools disabled.
 */
export function readSessionTools(dir: string, expectedSession: string): SessionToolsRead {
  const out = readJsonIfExists(join(dir, SESSION_TOOLS_FILE));
  if (!out.exists) return { disabled: [], warnings: [] };
  const voided = (reason: string): SessionToolsRead => ({
    disabled: [],
    warnings: ["tools_unreadable: " + reason + " — the session runs with no tools disabled"],
  });
  if (out.error !== undefined) return voided("unparsable tools.json: " + out.error);
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return voided("tools.json is not an object");
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return voided("unknown tools.json version " + JSON.stringify(rec["version"]));
  if (rec["session"] !== expectedSession) return voided("tools.json belongs to " + JSON.stringify(rec["session"]));
  const raw = rec["disabled"];
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string")) return voided("tools.json has no \`disabled\` array of strings");
  return { disabled: normalizeDisabledTools(raw as string[]), warnings: [] };
}

/**
 * The ONE normalizer: trim, drop blanks, dedupe, keep first-occurrence order.
 * The PUT endpoint validates the raw array first (any non-string or blank is a
 * 422); a hand-written file goes through the same function on read, where a
 * blank entry is merely dropped.
 */
export function normalizeDisabledTools(disabled: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of disabled) {
    const name = value.trim();
    if (name === "" || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** Normalize + atomic 0600 write; returns the list that was persisted. */
export function writeSessionTools(dir: string, session: string, disabled: readonly string[], now: number): string[] {
  const normalized = normalizeDisabledTools(disabled);
  writeJsonAtomic(join(dir, SESSION_TOOLS_FILE), { version: 1, session, disabled: normalized, updated_at: now }, { mode: 0o600 });
  return normalized;
}
