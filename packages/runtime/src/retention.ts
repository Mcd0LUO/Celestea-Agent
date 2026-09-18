/**
 * Host-side half of tool-result retention (W855): WHERE the spilled bytes go.
 *
 * The policy (thresholds, head/tail window, the "spill and replace" decision)
 * lives in \@celestea/agent-loop (L1, core-only). This module owns the
 * persistence: full text -> <session-dir>/spills/<call>-<n>.txt, a locator the
 * model can read back, and a tool-shaped retrieval hint.
 *
 * Fail-soft by construction: no session dir, an unwritable dir or a write error
 * all return null, and the loop then keeps the full result inline. A successful
 * tool call is never turned into an error by a failed spill.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_PREVIEW_HEAD_BYTES,
  DEFAULT_PREVIEW_TAIL_BYTES,
  DEFAULT_SINGLE_RESULT_BYTES,
  DEFAULT_STEP_RESULT_BYTES,
  type SpillRef,
  type ToolResultRetention,
} from "@celestea/agent-loop";

/** Single-result threshold override (bytes). */
export const SINGLE_RESULT_ENV = "CELESTEA_TOOL_RESULT_MAX_BYTES";
/** Per-step cumulative threshold override (bytes). */
export const STEP_RESULT_ENV = "CELESTEA_STEP_TOOL_RESULT_MAX_BYTES";
/** Inline head window override (bytes). */
export const PREVIEW_HEAD_ENV = "CELESTEA_TOOL_RESULT_PREVIEW_HEAD_BYTES";
/** Inline tail window override (bytes). */
export const PREVIEW_TAIL_ENV = "CELESTEA_TOOL_RESULT_PREVIEW_TAIL_BYTES";
/** Spill age override (ms); 0 disables the startup sweep entirely. */
export const SPILL_TTL_ENV = "CELESTEA_SPILL_TTL_MS";
/** Default spill age: `<session>/spills/*.txt` older than this are reaped at compose. */
export const DEFAULT_SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface RetentionSettings {
  /** Session directory; null = nothing can be spilled (retention is inert). */
  dir: string | null;
  singleResultBytes: number;
  stepResultBytes: number;
  previewHeadBytes: number;
  previewTailBytes: number;
  /** Age after which a spilled file is reaped at writer creation (0 = never). */
  spillTtlMs: number;
}

/** Non-negative integer from the environment, else the frozen default. */
function envBytes(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Thresholds from the environment, with the built-in defaults. */
export function retentionSettingsFromEnv(dir: string | null, env: NodeJS.ProcessEnv = process.env): RetentionSettings {
  return {
    dir,
    singleResultBytes: envBytes(env, SINGLE_RESULT_ENV, DEFAULT_SINGLE_RESULT_BYTES),
    stepResultBytes: envBytes(env, STEP_RESULT_ENV, DEFAULT_STEP_RESULT_BYTES),
    previewHeadBytes: envBytes(env, PREVIEW_HEAD_ENV, DEFAULT_PREVIEW_HEAD_BYTES),
    previewTailBytes: envBytes(env, PREVIEW_TAIL_ENV, DEFAULT_PREVIEW_TAIL_BYTES),
    spillTtlMs: envBytes(env, SPILL_TTL_ENV, DEFAULT_SPILL_TTL_MS),
  };
}

/**
 * Reap spilled files older than `ttlMs` from `<dir>/spills` (W855 #8a).
 *
 * Policy: an AGE threshold, not "delete everything" — a fresh spill is the
 * model's retrieval target and must survive a same-day recompose; only files a
 * full TTL old are removed, so the directory cannot grow without bound across
 * restarts. Synchronous and fail-soft: a missing/unreadable directory or one
 * failed unlink never fails a compose. Returns the number of files removed.
 */
export function sweepSpills(dir: string | null, ttlMs: number, now: number = Date.now()): number {
  if (dir === null || dir === "" || ttlMs <= 0) return 0;
  const spills = join(dir, "spills");
  let names: string[];
  try {
    names = readdirSync(spills);
  } catch {
    return 0; // ENOENT (nothing spilled yet) or unreadable: nothing to do.
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".txt")) continue;
    const full = join(spills, name);
    try {
      if (now - statSync(full).mtimeMs > ttlMs) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // A file that vanished or cannot be stat'ed/unlinked is left alone.
    }
  }
  return removed;
}

/** Build the session-scoped spill writer. */
export function createToolResultRetention(settings: RetentionSettings): ToolResultRetention {
  // W855 #8a: reap stale spills once per session generation (startup sweep).
  sweepSpills(settings.dir, settings.spillTtlMs);
  let seq = 0;
  return {
    singleResultBytes: settings.singleResultBytes,
    stepResultBytes: settings.stepResultBytes,
    previewHeadBytes: settings.previewHeadBytes,
    previewTailBytes: settings.previewTailBytes,
    async spill(text: string, meta: { callId: string }): Promise<SpillRef | null> {
      if (settings.dir === null || settings.dir === "") return null;
      try {
        const dir = join(settings.dir, "spills");
        await mkdir(dir, { recursive: true });
        seq += 1;
        const safe = meta.callId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "call";
        const locator = join(dir, safe + "-" + String(seq) + ".txt");
        await writeFile(locator, text, "utf8");
        return {
          locator,
          bytes: Buffer.byteLength(text, "utf8"),
          retrievalHint: 'read_file path="' + locator + '"',
        };
      } catch (e) {
        // Best-effort: a failed spill must never fail the tool call. Record it
        // and let the loop keep the full result inline.
        process.stderr.write(
          "[celestea-runtime] tool-result spill failed: " + (e instanceof Error ? e.message : String(e)) + "\n",
        );
        return null;
      }
    },
  };
}
