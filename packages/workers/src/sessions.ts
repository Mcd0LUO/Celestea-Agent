/**
 * SessionRegistry — the addressable conversations the worker tools can reach.
 *
 * Port of `celestea_session::SessionRegistry` (crates/session/src/registry.rs:120-196):
 * ids are `session-<n>`, unique per process; `resolve` accepts an id, else a
 * title, else a workspace grouping, and reports an AMBIGUOUS match with its
 * candidates instead of guessing (the tool surfaces the candidate list to the
 * model so it can re-address by id).
 *
 * The registry holds logs, never conversations-with-behavior: driving is the
 * driver's job (see driver.ts), and the log implementation is injected (see
 * log.ts for why).
 */

import type { SessionLog } from "@celestea/core";
import { recordingSessionLog, type SessionLogFactory } from "./log.js";
import type { WorkerSession, WorkerSessionMeta, WorkerSessionSpec } from "./types.js";

export type ResolveError =
  | { kind: "not_found"; target: string }
  | { kind: "ambiguous"; target: string; candidates: WorkerSessionMeta[] };

export interface ResolveResult {
  session?: WorkerSession;
  error?: ResolveError;
}

export interface SessionRegistryOptions {
  /** Log implementation for new sessions (default: recording-only, see log.ts). */
  logFactory?: SessionLogFactory;
  /** Id prefix (`session-`; tests use it to keep ids readable). */
  prefix?: string;
}

export class SessionRegistry {
  private readonly byId = new Map<string, WorkerSession>();
  private readonly logFactory: SessionLogFactory;
  private readonly prefix: string;
  private nextId = 0;

  constructor(opts: SessionRegistryOptions = {}) {
    this.logFactory = opts.logFactory ?? recordingSessionLog;
    this.prefix = opts.prefix ?? "session-";
  }

  /** Create a session, register it and return it. */
  create(spec: WorkerSessionSpec): WorkerSession {
    // W1470: an id that is already registered is never handed out twice — an
    // adopted (rehydrated) session occupies its id exactly like a live one, so a
    // restart can no longer mint `session-0` for a second worker.
    while (this.byId.has(`${this.prefix}${this.nextId}`)) this.nextId += 1;
    const id = `${this.prefix}${this.nextId}`;
    this.nextId += 1;
    const session: WorkerSession = {
      meta: { id, title: spec.title, workspace: spec.workspace ?? null, model: spec.model ?? null, mode: spec.mode ?? null, permission: spec.permission ?? null },
      log: this.logFactory(),
    };
    this.byId.set(id, session);
    return session;
  }

  /** Register an existing session under its own id (the host conversation). */
  register(session: WorkerSession): void {
    this.byId.set(session.meta.id, session);
  }

  /**
   * W1470: adopt PERSISTED sessions — the conversations a previous process
   * minted and the table still names. Read-only (it never touches the table) and
   * idempotent (an id that is already registered keeps its live session, so a
   * later reload can never downgrade a real one to a placeholder).
   */
  adopt(metas: readonly WorkerSessionMeta[]): void {
    for (const meta of metas) {
      if (this.byId.has(meta.id)) continue;
      this.byId.set(meta.id, { meta: { ...meta }, log: this.logFactory() });
    }
  }

  /**
   * W1470: never mint an id the persisted table already names. Seeding the
   * counter (rather than only skipping on collision) keeps the ids MONOTONIC
   * across restarts, which is what makes a stale row's `sess=` recognisable.
   */
  reserve(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!id.startsWith(this.prefix)) continue;
      const rest = id.slice(this.prefix.length);
      const n = Number.parseInt(rest, 10);
      if (Number.isSafeInteger(n) && String(n) === rest && n >= this.nextId) this.nextId = n + 1;
    }
  }

  /** The id prefix this registry mints (`workerSessionPrefix(host)`). */
  get prefixOf(): string {
    return this.prefix;
  }

  get(id: string): WorkerSession | undefined {
    return this.byId.get(id);
  }

  /** The session's log, or undefined when the id is unknown. */
  logOf(id: string): SessionLog | undefined {
    return this.byId.get(id)?.log;
  }

  remove(id: string): boolean {
    return this.byId.delete(id);
  }

  metas(): WorkerSessionMeta[] {
    return [...this.byId.values()].map((s) => ({ ...s.meta }));
  }

  get size(): number {
    return this.byId.size;
  }

  /** Drop every session (generation shutdown releases the logs with it). */
  clear(): void {
    this.byId.clear();
  }

  /** id -> title -> workspace resolution; ambiguity is reported, never guessed. */
  resolve(target: string): ResolveResult {
    const exact = this.byId.get(target);
    if (exact !== undefined) return { session: exact };
    const candidates = this.metas().filter((m) => m.title === target || m.workspace === target);
    if (candidates.length === 0) return { error: { kind: "not_found", target } };
    if (candidates.length > 1) return { error: { kind: "ambiguous", target, candidates } };
    const only = candidates[0];
    const session = only === undefined ? undefined : this.byId.get(only.id);
    if (session === undefined) return { error: { kind: "not_found", target } };
    return { session };
  }
}
