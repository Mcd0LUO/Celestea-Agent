/**
 * Fallback chain configuration (iteration E §4.2.4) — a sidecar, never a profile.
 *
 * The chain is read from `<data dir>/fallbacks.json` or from `CELESTEA_LLM_FALLBACKS`
 * (the same JSON, inline), and the capability is gated by `CELESTEA_LLM_FALLBACK`
 * (`on|1|true|yes`; **default off** — §4.3 P1, D9). Keeping it here instead of in
 * `Profile` is deliberate: `Profile` is the frozen 12-key contract, so widening it
 * would drag `contracts/` and the legacy side along (§4.2.4 "诚实取舍").
 *
 * Two disciplines are enforced in code, not in prose:
 *   - the config records env var NAMES only — a key value can never reach here
 *     (§4.5 R4-3), and `available()` answers "is the credential present" without
 *     ever reading a value out of the environment;
 *   - a chain that is switched on but broken is REPORTED (`problems[]`), never
 *     silently downgraded to "no fallback" (U7: `enabled:true` must say that a
 *     target is unusable instead of skipping it quietly).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FallbackPolicy, LlmTarget } from "./fallback.js";

/** `<data dir>/fallbacks.json` (§4.2.4). */
export const FALLBACKS_FILE = "fallbacks.json";
/** `on|1|true|yes` enables the decorator; anything else (and absent) is OFF. */
export const ENV_FALLBACK_SWITCH = "CELESTEA_LLM_FALLBACK";
/** The same JSON inline (wins over the file). */
export const ENV_FALLBACKS = "CELESTEA_LLM_FALLBACKS";

/** The parsed sidecar. `version` is the file's own schema version. */
export interface FallbackConfig {
  version: number;
  /** Config-level switch; the env switch still has to be on as well. */
  enabled: boolean;
  targets: LlmTarget[];
  policy: Partial<FallbackPolicy>;
  /** `env` | `file` — where the chain came from (diagnostics/statusline). */
  source: "env" | "file";
  /** Non-fatal findings (missing key, no targets, …): never silent. */
  problems: string[];
}

/** Is the capability switched on? Default OFF (§4.2.4 / D9). */
export function fallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ENV_FALLBACK_SWITCH] ?? "").trim().toLowerCase();
  return ["on", "1", "true", "yes"].includes(raw);
}

/**
 * The configured chain, or null when the switch is off / nothing is configured.
 * A malformed JSON, a non-object, or a chain with zero targets is a `problem`,
 * and the caller decides what to report.
 */
export function loadFallbackConfig(opts: {
  dataDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): FallbackConfig | null {
  const env = opts.env ?? process.env;
  if (!fallbackEnabled(env)) return null;
  const inline = (env[ENV_FALLBACKS] ?? "").trim();
  if (inline !== "") return parseConfig(inline, "env");
  const dir = opts.dataDir;
  if (dir === null || dir === undefined || dir === "") return null;
  let raw: string;
  try {
    raw = readFileSync(join(dir, FALLBACKS_FILE), "utf8");
  } catch {
    return null;
  }
  return parseConfig(raw, "file");
}

/** Parse + validate one config document; unparsable input is a reported problem. */
export function parseConfig(raw: string, source: "env" | "file"): FallbackConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    return { version: 1, enabled: false, targets: [], policy: {}, source, problems: [`unparsable JSON (${text(e)})`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { version: 1, enabled: false, targets: [], policy: {}, source, problems: ["config must be a JSON object"] };
  }
  const rec = parsed as Record<string, unknown>;
  const targets = parseTargets(rec["targets"]);
  const problems: string[] = [];
  if (targets.length === 0) problems.push("no targets configured");
  return {
    version: typeof rec["version"] === "number" ? rec["version"] : 1,
    enabled: rec["enabled"] !== false,
    targets,
    policy: parsePolicy(rec["policy"]),
    source,
    problems,
  };
}

function parseTargets(raw: unknown): LlmTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmTarget[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = str(rec["name"]);
    const model = str(rec["model"]);
    if (name === null || model === null) continue;
    out.push({
      name,
      provider: str(rec["provider"]) ?? name,
      model,
      baseUrl: str(rec["baseUrl"]),
      apiKeyEnv: str(rec["apiKeyEnv"]),
    });
  }
  return out;
}

function parsePolicy(raw: unknown): Partial<FallbackPolicy> {
  if (typeof raw !== "object" || raw === null) return {};
  const rec = raw as Record<string, unknown>;
  const out: Partial<FallbackPolicy> = {};
  for (const key of ["maxAttempts", "cooldownMs", "failureThreshold"] as const) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
  }
  for (const key of ["notRetryableStatuses", "retryableStatuses"] as const) {
    const value = rec[key];
    if (Array.isArray(value)) {
      const statuses = value.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      if (statuses.length > 0) out[key] = statuses;
    }
  }
  if (typeof rec["respectRetryAfter"] === "boolean") out.respectRetryAfter = rec["respectRetryAfter"];
  return out;
}

/**
 * Credential inventory (U7) — env var NAMES only, never values: a target that
 * names an `apiKeyEnv` which the process does not define is UNAVAILABLE, and the
 * caller must report it instead of dropping the target silently.
 */
export function targetAvailability(
  targets: readonly LlmTarget[],
  env: NodeJS.ProcessEnv = process.env,
): Array<{ name: string; model: string; available: boolean; missingEnv: string | null }> {
  return targets.map((target) => {
    const envName = target.apiKeyEnv ?? null;
    const missing = envName !== null && (env[envName] ?? "") === "";
    return { name: target.name, model: target.model, available: !missing, missingEnv: missing ? envName : null };
  });
}

/** The `problems[]` of a chain, including the credentials it cannot use (U7). */
export function configProblems(config: FallbackConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...config.problems];
  for (const t of targetAvailability(config.targets, env)) {
    if (!t.available) out.push(`target '${t.name}' has no credential (env ${t.missingEnv} is unset)`);
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
