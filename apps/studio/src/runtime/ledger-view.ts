/**
 * The usage ledger's HOST-side views (E-P1, capability 3, W785).
 *
 * `RealEngine` (real-runtime-adapter.ts) owns the lifecycle of the process-wide
 * ledger file, but it does not own the SHAPES the HTTP layer promises. Those live
 * here as three pure functions so the adapter stays a thin seam (and stays inside
 * the §4.1 file budget):
 *
 *   - [usageLedgerView] — `GET /api/usage/ledger`: the runtime's own `queryLedger`
 *     over the file's records, or the honest `ok:false` when there is no ledger;
 *   - [costBlockView]   — `/api/status.cost`: one session's block, `null` when
 *     there is no ledger (the handler then omits the optional key);
 *   - [ledgerLabel]     — the label rows are booked under: `<workspace>/<session>`
 *     for a named session (`sessionIdOfDir`, the SAME label `session-compose.ts`
 *     uses), `sessionId ?? "cli-main"` for the detached generation.
 *
 * Both readers call `file.readAll()` on every request — the current file plus
 * the rolled `.1` segment (P2-2), so a rotation cannot zero the cumulative
 * view. The ledger stays the single source of truth, so nothing is cached and
 * a row booked a millisecond ago is visible to the next poll.
 */

import {
  HOST_SESSION_ID,
  ledgerCostBlock,
  queryLedger,
  sessionIdOfDir,
  type LedgerCostBlock,
  type LedgerQuery,
  type LedgerQueryResult,
  type UsageLedgerFile,
} from "@celestea/runtime";

/** `ok:false` = there is no ledger to read here; never a fabricated empty view. */
export type LedgerUnavailable = { ok: false; error: string };

/** `GET /api/usage/ledger` over the process ledger (see the module header). */
export function usageLedgerView(
  file: UsageLedgerFile | null,
  q: LedgerQuery,
): LedgerQueryResult | LedgerUnavailable {
  if (file === null) return { ok: false, error: "usage ledger disabled" };
  try {
    return queryLedger(file.readAll(), q);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `/api/status.cost` over the process ledger (see the module header). */
export function costBlockView(
  file: UsageLedgerFile | null,
  session: string | null,
  dir: string | null,
): LedgerCostBlock | null {
  if (file === null) return null;
  try {
    return ledgerCostBlock(file.readAll(), ledgerLabel(session, dir));
  } catch {
    // Cost is a view: a broken ledger must not fail a status poll.
    return null;
  }
}

/** The ledger label of a session — the same one its rows are booked under. */
export function ledgerLabel(session: string | null, dir: string | null): string {
  return dir === null ? (session ?? HOST_SESSION_ID) : sessionIdOfDir(dir);
}
