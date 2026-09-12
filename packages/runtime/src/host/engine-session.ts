/**
 * Engine-side session binding helpers.
 *
 * The host owns the id space (`<workspace>/<session>`); the engine owns the
 * file name: every session directory holds ONE append-only `cli-main.jsonl`
 * (`celestea_studio/src/workspaces.rs` SESSION_FILE), so the log is always
 * opened under the fixed session id `cli-main` and never under the host id —
 * otherwise `file_name_for` would sanitize `ws/s1` into `ws_s1.jsonl` and the
 * engine would talk to a file the host never reads.
 *
 * When nothing is active (or the id is unknown) the generation runs on an
 * in-memory log: `/api/turn` still works, and the adapter never invents a
 * directory on behalf of the operator.
 *
 * E §1.3 P0 ②: a persistent log is wrapped in a checkpoint decorator, so every
 * `turn_start`/`turn_end` it records also updates `<dir>/checkpoint.json`. An
 * in-memory (detached) session has no directory and therefore no sidecar.
 *
 * W747: moved verbatim from `apps/studio/src/runtime/engine-session.ts` into the
 * runtime's host layer (behaviour, export names and log format unchanged; the old
 * path is now a re-export shim). The only edit is the import of the intra-package
 * session binding (`../session-binding.js` instead of the `@celestea/runtime`
 * alias, which would be a package self-cycle). `sessionIdOfDir` came with it, out
 * of the host's grants reader (`engine-grants.ts`), because the id space is what
 * this module already documents; the old path re-exports it unchanged.
 */

import { basename, dirname } from "node:path";
import { InMemorySessionLog } from "@celestea/session";
import { PersistentSessionLog } from "@celestea/session";
import {
  checkpointedLog,
  CheckpointStore,
  currentProcessIdentity,
  writeErrorCountOf,
  type CheckpointIdentity,
} from "@celestea/session";
import type { SessionLog } from "@celestea/core";
import { createSessionBinding, type SessionBinding } from "../session-binding.js";

/** The engine's per-session log file name. */
export const SESSION_LOG_NAME = "cli-main.jsonl";
/** The session id the log is opened under (keeps the file name cli-main.jsonl). */
export const SESSION_LOG_ID = "cli-main";

/**
 * W768: a session's workspace as ONE value — the display NAME the system prompt
 * renders and the ROOT PATH the tools/sandbox must run in.
 *
 * They travel together because they are the same fact seen twice: two
 * independent lookups (a prompt that says "CelesteaTeamAPI" and a shell that
 * starts in whatever the process was launched from) drifted apart into a bug the
 * model then reasoned from. A caller that needs either one resolves this value.
 */
export interface SessionWorkspace {
  /** Workspace key: the basename of `path` (`CelesteaTeamAPI`). */
  name: string;
  /** Absolute workspace root — the session's cwd and containment root. */
  path: string;
}

/** Where an active session lives (the host resolves the id; dir may be null). */
export interface SessionTarget {
  sessionId: string;
  dir: string | null;
  /** W768: the session's workspace, resolved by the host alongside `dir`. */
  workspace?: SessionWorkspace | null;
}

/**
 * Checkpoint wiring of one host process. `identity` is the `pid`/`boot_id` pair
 * written into every sidecar (E §1.2.2); tests inject a fixed one so the written
 * file is deterministic.
 */
export interface CheckpointWiring {
  identity?: CheckpointIdentity;
  now?: () => number;
  warn?: (message: string) => void;
}

/** `boot_id` is generated ONCE per process and never again while it lives. */
export const PROCESS_CHECKPOINT_IDENTITY: CheckpointIdentity = currentProcessIdentity();

/** `<workspace>/<session>` of a session directory (the file's self-description). */
export function sessionIdOfDir(sessionDir: string): string {
  return `${basename(dirname(sessionDir))}/${basename(sessionDir)}`;
}

/**
 * Open (replaying) the append-only log of a session directory, wrapped so the
 * turn boundaries also land in `<dir>/checkpoint.json` (E §1.3 P0 ②). The
 * wrapper is transparent: `path`, `close()` and `writeErrorCount()` still work
 * for the host and for the registry's turn-counter restoration.
 */
export function openSessionLog(dir: string, wiring: CheckpointWiring = {}): SessionLog {
  const log = PersistentSessionLog.open(dir, SESSION_LOG_ID);
  const store = new CheckpointStore({
    dir,
    // Self-description `<workspace>/<session>` — the id grants.json also uses, so
    // a sidecar found in a renamed directory is ignored instead of trusted.
    session: sessionIdOfDir(dir),
    identity: wiring.identity ?? PROCESS_CHECKPOINT_IDENTITY,
    ...(wiring.now === undefined ? {} : { now: wiring.now }),
    ...(wiring.warn === undefined ? {} : { warn: wiring.warn }),
    logWriteErrors: () => writeErrorCountOf(log),
  });
  return checkpointedLog(log, store);
}

/** One in-memory log per detached session id, reused across rebinds. */
export function memoryBindingFor(logs: Map<string, SessionLog>, sessionId: string | null): SessionBinding {
  const key = sessionId ?? "<detached>";
  const log = logs.get(key) ?? new InMemorySessionLog();
  logs.set(key, log);
  return createSessionBinding({ sessionId: key, dir: null, open: () => log });
}

/** The binding for a host session id (persistent when a directory is known). */
export function bindingFor(
  sessionId: string | null,
  target: SessionTarget | null,
  logs: Map<string, SessionLog>,
  wiring: CheckpointWiring = {},
): SessionBinding {
  if (sessionId === null || target === null || target.dir === null) return memoryBindingFor(logs, sessionId);
  const dir = target.dir;
  return createSessionBinding({ sessionId, dir, open: (): SessionLog => openSessionLog(dir, wiring) });
}

/**
 * Worker session-id prefix of one host session (W513).
 *
 * Every session runtime owns its OWN worker registry, and a registry mints
 * `session-<n>` by default — which would collide across sessions in the merged
 * `GET /api/sessions` view. The session id therefore prefixes the ids
 * (`sample-ws_s1-session-0`); the detached runtime keeps the frozen
 * `session-<n>` shape so single-session hosts and fixtures are unchanged.
 */
export function workerSessionPrefix(sessionId: string | null): string {
  if (sessionId === null) return "session-";
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}-session-`;
}

/** Close a session log when its implementation owns a descriptor (idempotent). */
export function closeLog(log: SessionLog | null | undefined): void {
  const close = log === null || log === undefined ? undefined : (log as { close?: () => void }).close;
  if (typeof close === "function") close.call(log);
}
