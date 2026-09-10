/**
 * Well-known service tokens the runtime owns.
 *
 * `core` freezes the seam tokens (`SESSION_LOG_SERVICE`, `LLM_SERVICE`,
 * `TOOL_REGISTRY_SERVICE`, `AGENT_LOOP_SERVICE`, `EVENT_BUS_SERVICE`). The
 * runtime adds the tokens that only exist because it drives turns: the
 * per-turn abort signal, the per-turn frame sink, and the two accounting
 * services. They follow the same convention (a stable namespaced string), so a
 * Context-aware `AgentLoop` implementation can resolve them without importing
 * this package (which would be an L1 -> L2 jump, ARCHITECTURE.md §1.3 D3).
 */

/** Per-turn `AbortSignal` (cooperative cancellation), provided on the turn scope. */
export const TURN_ABORT_SERVICE = "celestea.runtime.TurnAbort";
/** Per-turn frame sink: `(frame: TurnFrame) => void` (SSE-shaped, in log order). */
export const TURN_SINK_SERVICE = "celestea.runtime.TurnSink";
/** Shared usage accounting (`UsageAccounting`): latest + cumulative. */
export const USAGE_TRACKER_SERVICE = "celestea.runtime.UsageTracker";
/** Shared statusline tracker (`StatusTracker`): steps + delta rate. */
export const STATUS_TRACKER_SERVICE = "celestea.runtime.StatusTracker";

/** The host (coordinator) conversation id: registry / mailbox queue key. */
export const HOST_SESSION_ID = "cli-main";

/** Default directory the worker receipt protocol writes `results/<wid>-<short>.md` into. */
export const RESULTS_DIR = "results";

/** W218: context window used for the estimated ratio (contract display default). */
export const CONTEXT_WINDOW_FALLBACK = 1_000_000;
