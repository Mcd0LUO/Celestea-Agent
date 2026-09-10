/**
 * Environment helpers shared by the guard, the http policy and the sandbox
 * config. Env is always passed in explicitly (default `process.env`) so every
 * knob is testable without mutating global state.
 */

/** One env knob: read a string, a positive integer, or an on/off flag. */
export function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = envString(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/** On/off flag (`1/true/on/yes` vs `0/false/off/no`); anything else = fallback. */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return fallback;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return fallback;
}
