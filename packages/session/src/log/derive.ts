/**
 * The engine's `derive_messages` projection — A2 (W746): the algorithm moved
 * to `@celestea/core` (`core/src/projection.ts`, the same 1:1 port of
 * `crates/session/src/log.rs:73-204`), because it is seam behaviour, not
 * implementation behaviour: every `SessionLog` must project the same history,
 * and `SessionLog.deriveMessages()` is a seam method.
 *
 * This module stays as the stable import path inside the package (and for
 * callers of `@celestea/session`) so nothing else has to move; the rules,
 * parity notes and the W267 cursor quirk are documented where the code is.
 */

export {
  CANCELLED_TOOL_CALL_TEXT,
  balanceToolCalls,
  deriveMessagesFrom,
  flushToolCalls,
  projectEvent,
  toolResultText,
} from "@celestea/core";
