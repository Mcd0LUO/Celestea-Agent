/**
 * The two lifecycle operations of ONE session generation — `clear` and `compact`
 * (extracted from `real-runtime-adapter.ts`, W787: the adapter is the HTTP seam
 * and stays inside the §4.1 file budget; the operations themselves are about the
 * session runtime, not about the seam).
 *
 *   - `clearSession` empties the log and resets the turn counter of the LIVE
 *     instance, and 409s (`TurnBusyError`) while a turn is in flight — clearing
 *     a session mid-turn would delete the rows the turn is writing;
 *   - `compactSession` compacts `<dir>/cli-main.jsonl`, and when an instance is
 *     live it is EVICTED first and composed again afterwards: the compaction
 *     rewrites the file behind the log's descriptor, so reusing the old instance
 *     would keep serving the pre-compaction history from memory.
 */

import { join } from "node:path";
import { keyOfSession, runCompaction, type SessionRuntimeRegistry, type Summarizer } from "@celestea/runtime";
import { EngineError, type ClearOutcome, type CompactOutcome } from "../runtime-adapter.js";
import { TurnBusyError } from "@celestea/runtime";
import { SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";

/** The frozen "nothing to compact" note (kept in sync with compact/plan.ts). */
export const SKIPPED_NOTE = "历史不足，无需压缩";

export interface SessionLifecycleDeps {
  registry: SessionRuntimeRegistry;
  /** Host lookup (`<workspace>/<session>` -> dir); null for an unresolvable id. */
  resolve: (id: string) => SessionTarget | null;
  /** The compact summarizer of the current base profile. */
  summarizer: () => Summarizer;
}

export function clearSession(registry: SessionRuntimeRegistry, session: string | null): ClearOutcome {
  const entry = registry.peek(session);
  if (entry !== null) {
    if (entry.inFlight) throw new TurnBusyError("clear");
    entry.runtime.session.clear();
    entry.turnNo = 0;
  }
  return { cleared: true };
}

export async function compactSession(deps: SessionLifecycleDeps, session: string): Promise<CompactOutcome> {
  const target = deps.resolve(session);
  if (target === null || target.dir === null) {
    return { compacted: false, note: SKIPPED_NOTE, session, rebound: false };
  }
  const live = deps.registry.peek(session) !== null;
  if (live) await deps.registry.evict(keyOfSession(session));
  const result = await runCompactionOf(deps, join(target.dir, SESSION_LOG_NAME));
  if (live) deps.registry.ensure(session, target.dir);
  return {
    compacted: result.compacted,
    ...(result.compacted && result.kept_turns !== null ? { kept_turns: result.kept_turns } : {}),
    note: result.note,
    session,
    rebound: live && result.compacted,
  };
}

/** A compaction failure is an ENGINE error (HTTP 500), never a host-side crash. */
async function runCompactionOf(deps: SessionLifecycleDeps, logPath: string): Promise<{ compacted: boolean; kept_turns: number | null; note: string }> {
  try {
    return await runCompaction({ logPath, summarize: deps.summarizer() });
  } catch (e) {
    throw new EngineError(e instanceof Error ? e.message : String(e));
  }
}
