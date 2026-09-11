/**
 * The session grant boundary at COMPOSE time (W516 §4.2, §4.4).
 *
 * One instance per session is composed per turn boundary, so this is where the
 * session's widenings are read, audited and (for one-shot entries) spent. "Read
 * at compose" is what makes a grant land in the NEXT turn and never inside the
 * running one: the instance a turn runs on keeps the boundary it was composed
 * with, whatever happens to `grants.json` meanwhile.
 *
 * Honest limits of this implementation (also listed in the W516 report): `use`
 * is sampled once per composed generation (i.e. per turn boundary) rather than
 * once per sandbox spawn, and a one-shot entry is spent at compose time — the
 * safe direction (it can only be lost earlier, never used twice).
 */

import { effectiveGrantsOf, expiredGrants, sessionIdOfDir, type EffectiveGrants } from "./engine-grants.js";
import type { EngineGrantAudit, EngineGrantEvent } from "./engine-grants.js";
import { GrantsAuditWriter } from "../store/grants-audit.js";
import { isExpired, readGrantsFile, writeGrantsFile, type GrantRecord, type GrantsFile } from "../store/grants.js";

/** Caps whose use changes the process environment → always sampled (§4.4). */
const HEAVY_CAPS: readonly string[] = ["network", "unsandboxed"];

export interface GrantsReadResult {
  grants: EffectiveGrants;
  warnings: string[];
}

export interface SessionGrantsReader {
  /** Effective grants of one session directory (never throws — §4.1). */
  read(sessionId: string | null, dir: string | null): GrantsReadResult;
  /** Audit the boundary + spend one-shot entries; called once per compose. */
  onComposed(sessionId: string | null, dir: string | null, read: GrantsReadResult): void;
  /** An audit sink already bound to one session. */
  audit(sessionId: string | null): EngineGrantAudit;
  /** Await in-flight platform-audit deliveries (tests / shutdown). */
  flush(): Promise<void>;
}

export interface SessionGrantsOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

interface ComposedCtx {
  env: NodeJS.ProcessEnv;
  now: () => number;
}

export function createSessionGrants(opts: SessionGrantsOptions): SessionGrantsReader {
  const writer = new GrantsAuditWriter({ dataDir: opts.dataDir, env: opts.env, now: opts.now ?? Date.now });
  const audit = (sessionId: string | null): EngineGrantAudit => (event: EngineGrantEvent) =>
    writer.write({ session: sessionId ?? "", ...event });
  const ctx: ComposedCtx = { env: opts.env, now: opts.now ?? Date.now };
  return {
    read: (sessionId, dir) => effectiveGrantsOf(dir, ctx.env, Math.floor(ctx.now() / 1000)),
    audit,
    flush: () => writer.flush(),
    onComposed: (sessionId, dir, result) => recordComposed(writer, sessionId, dir, result, ctx),
  };
}

/** Warnings → audit; heavyweight caps → `use`; expired / one-shot entries. */
function recordComposed(
  writer: GrantsAuditWriter,
  sessionId: string | null,
  dir: string | null,
  result: GrantsReadResult,
  ctx: ComposedCtx,
): void {
  const session = sessionId ?? "";
  const sink = (event: EngineGrantEvent): void => writer.write({ session, ...event });
  const seconds = Math.floor(ctx.now() / 1000);
  for (const warning of result.warnings) {
    const event = warning.startsWith("grants_unreadable") ? "grants_unreadable" : "deny";
    sink({ event, reason: warning });
  }
  for (const source of result.grants.sources) {
    if (!HEAVY_CAPS.includes(source.cap)) continue;
    sink({ event: "use", cap: source.cap, grant_id: source.grantId, detail: "active for the composed session instance" });
  }
  const read = dir === null ? null : readGrantsFile(dir, sessionIdOfDir(dir));
  if (read?.file === undefined) return;
  for (const grant of expiredGrants(read.file, seconds)) sink({ event: "expire", cap: grant.cap, grant_id: grant.id });
  spendOneShot(writer, { dir, file: read.file, active: new Set(result.grants.sources.map((s) => s.grantId)), seconds, env: ctx.env });
}

interface SpendCtx {
  dir: string | null;
  file: GrantsFile;
  active: ReadonlySet<string>;
  seconds: number;
  env: NodeJS.ProcessEnv;
}

/** Remove the one-shot entries that were just composed in (§2.3). */
function spendOneShot(writer: GrantsAuditWriter, ctx: SpendCtx): void {
  const spent = ctx.file.grants.filter((entry) => entry.uses_left === 1 && ctx.active.has(entry.id) && !isExpired(entry, ctx.seconds));
  if (ctx.dir === null || spent.length === 0) return;
  const keep: GrantRecord[] = ctx.file.grants.filter((entry) => !spent.some((s) => s.id === entry.id));
  try {
    writeGrantsFile(ctx.dir, { version: 1, session: sessionIdOfDir(ctx.dir), updated_at: ctx.seconds, grants: keep }, { env: ctx.env, now: ctx.seconds });
  } catch {
    return; // best-effort: the entry stays and stays valid for one more turn
  }
  for (const entry of spent) {
    writer.write({ session: sessionIdOfDir(ctx.dir), event: "use", cap: entry.cap, grant_id: entry.id, uses_left: 0, detail: "one-shot grant spent" });
  }
}
