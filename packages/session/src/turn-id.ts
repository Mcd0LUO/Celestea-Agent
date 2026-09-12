/**
 * Turn id math — A2 (W746): moved to `@celestea/core` (`core/src/turn-id.ts`)
 * because `SessionLog.nextTurnId()` is a seam method: the log owns the counter
 * and every implementation must mint the same `turn-<n>` ids from the same
 * arithmetic. This module stays as the stable import path inside the package.
 */

export {
  auditTurnIds,
  formatTurnId,
  maxTurnNumber,
  nextTurnId,
  nextTurnNumber,
  parseTurnNumber,
} from "@celestea/core";
export type { TurnIdAudit } from "@celestea/core";
