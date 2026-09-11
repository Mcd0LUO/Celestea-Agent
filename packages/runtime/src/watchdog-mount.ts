/**
 * W740 — the watchdog at the composition root.
 *
 * W736 built the liveness adjudicator (`@celestea/workers` `watchdog.ts`:
 * keep-running / done / grace-deferred / respawned / failed / probe-error, with
 * `WorkerRegistry.finalize` as the single terminal write point) but never mounted
 * it, so nothing swept the RUNNING rows of the engine's own worker registry in
 * production. This module is that mount — and nothing else:
 *
 *   - it resolves the cadence and the retry/grace budgets from the environment
 *     (`celesteaWatchdogSettings`) with SAFE defaults, so a bad value degrades to
 *     the default instead of killing startup or hot-looping;
 *   - it mounts `watchdogPlugin` into the session's Context, which both schedules
 *     the sweep (interval timer, `unref`ed) and provides `WATCHDOG_SERVICE` for
 *     tool/host readers;
 *   - it hands back a stop function, so shutdown/dispose clears the timer (a
 *     sweep timer must never outlive the generation that owns the registry).
 *
 * SCOPE (W740 boundary, mirrors W736): the registry watched here is the STUDIO
 * ENGINE's per-session, in-process worker registry. It is NOT the DSH plugin's
 * cross-process `registry.tsv`; no `proc=` liveness rule and no cross-instance
 * judgement is introduced. The watchdog only ever adjudicates `ownEntries()`.
 */

import { mountPlugins, type Context } from "@celestea/core";
import {
  WATCHDOG_DEFAULTS,
  WATCHDOG_SERVICE,
  watchdogPlugin,
  type Watchdog,
  type WatchdogConfig,
  type WorkerRegistry,
} from "@celestea/workers";

/** Mount name of the watchdog (kept distinct from the workers plugin's name). */
export const WATCHDOG_PLUGIN_NAME = "celestea.runtime.watchdog";

/** `CELESTEA_WATCHDOG=off` (or `0`/`false`/`no`) disables the mount entirely. */
export const WATCHDOG_ENV = "CELESTEA_WATCHDOG";
/** `CELESTEA_WATCHDOG_INTERVAL_MS` — sweep period (0 = off). */
export const WATCHDOG_INTERVAL_ENV = "CELESTEA_WATCHDOG_INTERVAL_MS";
/** `CELESTEA_WATCHDOG_MAX_RETRIES` — re-dispatch ceiling per worker. */
export const WATCHDOG_MAX_RETRIES_ENV = "CELESTEA_WATCHDOG_MAX_RETRIES";
/** `CELESTEA_WATCHDOG_GRACE_MS` — fresh-spawn grace before an anomaly is judged. */
export const WATCHDOG_GRACE_ENV = "CELESTEA_WATCHDOG_GRACE_MS";

/** Cadence + budgets + on/off of the mounted watchdog. */
export interface WatchdogMountSettings {
  /** Start sweeping at mount time (false = the caller ticks by hand). */
  autostart: boolean;
  /** Sweep period in ms (`> 0`; 0 is never produced — it means "off"). */
  intervalMs: number;
  maxRetries: number;
  graceMs: number;
  /** Append-only verdict log (`null` = the library default: no deployment path). */
  watcherLog: string | null;
  alertsLog: string | null;
}

/** Defaults: ON, W736's production cadence, library log paths (off). */
export const WATCHDOG_MOUNT_DEFAULTS: WatchdogMountSettings = {
  autostart: true,
  intervalMs: WATCHDOG_DEFAULTS.intervalMs,
  maxRetries: WATCHDOG_DEFAULTS.maxRetries,
  graceMs: WATCHDOG_DEFAULTS.graceMs,
  watcherLog: null,
  alertsLog: null,
};

/** `off` / `0` / `false` / `no` (case-insensitive) mean "do not mount". */
export function watchdogDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[WATCHDOG_ENV] ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

/**
 * Cadence and budgets from the environment. Every input is validated: a
 * non-numeric, negative or non-positive-period value falls back to the default,
 * so a typo can neither abort composition nor spin the sweep in a hot loop.
 */
export function celesteaWatchdogSettings(env: NodeJS.ProcessEnv): WatchdogMountSettings {
  if (watchdogDisabled(env)) {
    return { ...WATCHDOG_MOUNT_DEFAULTS, autostart: false, intervalMs: 0 };
  }
  return {
    autostart: true,
    intervalMs: positiveFrom(env, WATCHDOG_INTERVAL_ENV, WATCHDOG_MOUNT_DEFAULTS.intervalMs),
    maxRetries: countFrom(env, WATCHDOG_MAX_RETRIES_ENV, WATCHDOG_MOUNT_DEFAULTS.maxRetries),
    graceMs: positiveFrom(env, WATCHDOG_GRACE_ENV, WATCHDOG_MOUNT_DEFAULTS.graceMs),
    watcherLog: null,
    alertsLog: null,
  };
}

/** What the composition root keeps after mounting the watchdog. */
export interface MountedWatchdog {
  /** The adjudicator the plugin provided (the host ticks it by hand in tests). */
  watchdog: Watchdog;
  /** Clear the sweep timer (idempotent; shutdown/dispose calls it). */
  stop: () => void;
}

/**
 * Mount the watchdog over one composed worker registry. Returns null when the
 * watchdog is switched off — in that case NO service is provided and NO timer
 * exists, which is what makes "off" observable rather than merely quiet.
 *
 * `settings.autostart: false` still mounts (and still provides the token); it
 * only leaves the cadence to the caller, which is how a test drives `tick()`.
 */
export function mountWatchdog(
  ctx: Context,
  registry: WorkerRegistry,
  settings: Partial<WatchdogMountSettings> = {},
): MountedWatchdog | null {
  const cfg: WatchdogMountSettings = { ...WATCHDOG_MOUNT_DEFAULTS, ...settings };
  if (!cfg.autostart || cfg.intervalMs <= 0) return null;
  const config: Partial<WatchdogConfig> = {
    intervalMs: cfg.intervalMs,
    resultsDir: registry.resultsDir,
    maxRetries: cfg.maxRetries,
    graceMs: cfg.graceMs,
    watcherLog: cfg.watcherLog,
    alertsLog: cfg.alertsLog,
  };
  mountPlugins(ctx, [watchdogPlugin({ registry, config, autostart: true, name: WATCHDOG_PLUGIN_NAME })]);
  const watchdog = ctx.get<Watchdog>(WATCHDOG_SERVICE);
  if (watchdog === undefined) return null;
  return { watchdog, stop: (): void => watchdog.stop() };
}

/**
 * The shutdown hook of a mounted watchdog: clearing the interval is the whole
 * job, and it is idempotent, so it can be registered as a host teardown hook
 * without a second bookkeeping path. `null` (watchdog off) is a no-op.
 */
export function stopWatchdog(mounted: MountedWatchdog | null): () => void {
  return (): void => mounted?.stop();
}

/** Non-negative integer from the env, else the fallback (0 is allowed). */
function countFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Strictly positive integer from the env, else the fallback (0 means "off"). */
function positiveFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
