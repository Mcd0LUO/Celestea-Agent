/**
 * The session package as a PLUGIN (rule 3: everything is a plugin).
 *
 * `packages/session` never gets imported by `core`: it only provides a
 * [SessionLog] implementation into a [Context] under the well-known
 * `SESSION_LOG_SERVICE` token, exactly like `celestea-session` is plugged into
 * the Rust harness at compose time. A later mount of the same token wins, so a
 * test can swap in an in-memory log over a persistent one.
 */

import { definePlugin, SESSION_LOG_SERVICE, type Plugin, type SessionLog } from "@celestea/core";
import { InMemorySessionLog } from "./log/memory.js";
import { PersistentSessionLog, type PersistentOptions } from "./log/persistent.js";

/** Provide an (optionally pre-populated) in-memory log. */
export function inMemorySessionLogPlugin(
  name = "celestea.session.InMemorySessionLog",
  log: SessionLog = new InMemorySessionLog(),
): Plugin {
  return definePlugin(name, (ctx) => ctx.provide(SESSION_LOG_SERVICE, log));
}

export interface PersistentSessionLogOptions {
  dir: string;
  sessionId: string;
  options?: PersistentOptions;
}

/** Open a JSONL-backed log and provide it (the log is returned via `onOpen`). */
export function persistentSessionLogPlugin(
  cfg: PersistentSessionLogOptions,
  onOpen?: (log: PersistentSessionLog) => void,
  name = "celestea.session.PersistentSessionLog",
): Plugin {
  return definePlugin(name, (ctx) => {
    const log = PersistentSessionLog.open(cfg.dir, cfg.sessionId, cfg.options);
    onOpen?.(log);
    ctx.provide(SESSION_LOG_SERVICE, log);
  });
}
