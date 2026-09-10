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
 */

import { InMemorySessionLog } from "@celestea/session";
import { PersistentSessionLog } from "@celestea/session";
import type { SessionLog } from "@celestea/core";
import { createSessionBinding, type SessionBinding } from "@celestea/runtime";

/** The engine's per-session log file name. */
export const SESSION_LOG_NAME = "cli-main.jsonl";
/** The session id the log is opened under (keeps the file name cli-main.jsonl). */
export const SESSION_LOG_ID = "cli-main";

/** Where an active session lives (the host resolves the id; dir may be null). */
export interface SessionTarget {
  sessionId: string;
  dir: string | null;
}

/** Open (replaying) the append-only log of a session directory. */
export function openSessionLog(dir: string): SessionLog {
  return PersistentSessionLog.open(dir, SESSION_LOG_ID);
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
): SessionBinding {
  if (sessionId === null || target === null || target.dir === null) return memoryBindingFor(logs, sessionId);
  const dir = target.dir;
  return createSessionBinding({ sessionId, dir, open: (): SessionLog => openSessionLog(dir) });
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
