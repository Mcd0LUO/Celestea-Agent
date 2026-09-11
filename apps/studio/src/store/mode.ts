/**
 * Session modes — the P0 vocabulary of "how a session works"
 * (`docs/modes-standard-vs-execution.md` §1.1, D1/D2).
 *
 * `standard` is exactly today's behaviour (call the tools directly); `execution`
 * is the same engine with the *behaviour contract* turned toward one
 * `run_code` program per dependent sequence. P0 changes ONLY the assembled
 * `tool_access` section — the tool face is identical in both modes (§1.2, D5).
 *
 * K3: the whole mode table lives here as module-level constants (no literal list
 * is re-written at a call site), and this file is plain data + pure parsers, so
 * every consumer (session meta, session rows, prompts, handlers) shares ONE
 * definition of the vocabulary.
 *
 * This is NOT the DSH host's agent preset (D4/§3.3): `mode` is the only mode
 * semantics the Studio engine knows; the host preset name is derived OUTSIDE
 * this repository, at the spawn boundary, and must never appear here.
 */

/** The two literals, in frozen order. */
export const SESSION_MODES = ["standard", "execution"] as const;

/** The mode of a session; a session that never declared one reads as `standard`. */
export type SessionMode = (typeof SESSION_MODES)[number];

/** Absent/blank/unknown mode reads as this — and it is never written to disk. */
export const DEFAULT_SESSION_MODE: SessionMode = "standard";

/** A mode literal, or `null` when `raw` is not one (never throws). */
export function parseMode(raw: unknown): SessionMode | null {
  return typeof raw === "string" && (SESSION_MODES as readonly string[]).includes(raw) ? (raw as SessionMode) : null;
}

/**
 * Tolerant read: anything that is not a literal (absent, blank, hand-edited
 * junk) degrades to [DEFAULT_SESSION_MODE], exactly like a missing key (K8/U9).
 */
export function effectiveMode(raw: unknown): SessionMode {
  return parseMode(raw) ?? DEFAULT_SESSION_MODE;
}

/** Write-path validation: `null` = acceptable, else the frozen 400 text (M2). */
export function validateMode(raw: string): string | null {
  return parseMode(raw) === null ? `invalid mode: ${raw}` : null;
}

/** True when the value is a declared literal (the `contracts/` enum, §4.1). */
export function isSessionMode(raw: unknown): raw is SessionMode {
  return parseMode(raw) !== null;
}
