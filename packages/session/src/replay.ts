/** Structural analysis of a replayed session log (P0 replay comparison). */

import { outcomePhase, type ParseJsonlResult } from "./jsonl.js";
import { auditTurnIds, type TurnIdAudit } from "./turn-id.js";
import type { SessionEvent } from "@celestea/core";

export interface ReplayStats {
  physicalLines: number;
  parsedEvents: number;
  blankLines: number;
  tornTail: ParseJsonlResult["tornTail"];
  turnStarts: number;
  turnEnds: number;
  /** turn_start rows with no matching turn_end (a killed/crashed turn). */
  danglingTurns: number;
  toolCalls: number;
  toolResults: number;
  /** tool_call rows with no matching tool_result id. */
  danglingToolCalls: Array<{ id: string; name: string }>;
  /** tool_result rows with no matching tool_call id. */
  orphanToolResults: string[];
  /** W255 run_code sub-calls (parent_id present). */
  subCalls: number;
  subCallParents: string[];
  thinkingEvents: number;
  userMessages: number;
  assistantMessages: number;
  outcomes: Record<string, number>;
  turnIds: TurnIdAudit;
}

export function analyzeReplay(parsed: ParseJsonlResult): ReplayStats {
  const events: readonly SessionEvent[] = parsed.events;
  const calls = new Map<string, string>();
  const results = new Set<string>();
  const subCallParents = new Set<string>();
  const outcomes: Record<string, number> = {};
  let turnStarts = 0;
  let turnEnds = 0;
  let thinkingEvents = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let subCalls = 0;

  for (const ev of events) {
    switch (ev.type) {
      case "turn_start":
        turnStarts += 1;
        break;
      case "turn_end":
        turnEnds += 1;
        outcomes[outcomePhase(ev.outcome)] = (outcomes[outcomePhase(ev.outcome)] ?? 0) + 1;
        break;
      case "thinking_delta":
        thinkingEvents += 1;
        break;
      case "user_message":
        userMessages += 1;
        break;
      case "assistant_message":
        assistantMessages += 1;
        break;
      case "tool_call":
        calls.set(ev.id, ev.name);
        if (ev.parent_id !== undefined) {
          subCalls += 1;
          subCallParents.add(ev.parent_id);
        }
        break;
      case "tool_result":
        results.add(ev.id);
        break;
    }
  }

  const danglingToolCalls: Array<{ id: string; name: string }> = [];
  for (const [id, name] of calls) if (!results.has(id)) danglingToolCalls.push({ id, name });
  const orphanToolResults: string[] = [];
  for (const id of results) if (!calls.has(id)) orphanToolResults.push(id);

  return {
    physicalLines: parsed.physicalLines,
    parsedEvents: parsed.events.length,
    blankLines: parsed.blankLines,
    tornTail: parsed.tornTail,
    turnStarts,
    turnEnds,
    danglingTurns: Math.max(0, turnStarts - turnEnds),
    toolCalls: calls.size,
    toolResults: results.size,
    danglingToolCalls,
    orphanToolResults,
    subCalls,
    subCallParents: [...subCallParents].sort(),
    thinkingEvents,
    userMessages,
    assistantMessages,
    outcomes,
    turnIds: auditTurnIds(events),
  };
}

/**
 * Derive the SSE transcript a client would have observed for this log.
 * `seq` is synthetic (the real counter is process-global and not recoverable
 * from the log); `turn` is the engine turn number.
 *
 * W834 F08 — what is reconstructable (and what is not):
 *   turn_start        -> status{phase:"start"}
 *   thinking_delta    -> thinking
 *   assistant_message -> text
 *   tool_call         -> tool
 *   tool_result       -> tool_result
 *   turn_end          -> turn_end + status
 *   user_question     -> question (payload mirrors runtime `questionFrame`)
 * Deliberately NOT reconstructable: `user_message` (never an SSE frame),
 * `user_answer` (the product emits no frame — the answer resolves the parked
 * promise in-process, `apps/studio/src/runtime/question-view.ts`), and the
 * `done`/`compact` frames (they have no session-log row).
 */
export interface DerivedSseFrame {
  event: string;
  data: { turn: number; seq: number; payload: Record<string, unknown> };
}

export function deriveSseTranscript(events: readonly SessionEvent[], startTurn = 0): DerivedSseFrame[] {
  const frames: DerivedSseFrame[] = [];
  let seq = 0;
  let turn = startTurn;
  let sawTurnStart = false;
  const push = (event: string, payload: Record<string, unknown>): void => {
    frames.push({ event, data: { turn, seq: seq++, payload } });
  };
  for (const ev of events) {
    switch (ev.type) {
      case "turn_start":
        turn += 1;
        sawTurnStart = true;
        push("status", { phase: "start" });
        break;
      case "user_message":
        break; // not an SSE event
      case "user_question":
        // W834 F08: the only frame a client can have seen for a question,
        // rebuilt from the row's own fields. `session` is null because the
        // derived envelope carries no session identity (the log does not
        // either); the other four keys mirror `questionFrame` exactly.
        push("question", {
          session: null,
          id: ev.id,
          questions: [...ev.questions],
          expires_at: ev.expires_at,
          timeout_ms: ev.timeout_ms,
        });
        break;
      case "user_answer":
        // The product emits NO frame when a question is answered: POST
        // /api/questions/{id}/answer resolves the parked promise directly
        // (question-view.ts). The row is the durable record; there is no
        // client-visible frame to rebuild, so it is explicitly skipped.
        break;
      case "thinking_delta":
        push("thinking", { delta: ev.text });
        break;
      case "assistant_message":
        push("text", { delta: ev.text });
        break;
      case "tool_call":
        push("tool", { id: ev.id, name: ev.name, args: ev.args });
        break;
      case "tool_result":
        push("tool_result", {
          id: ev.id,
          ok: ev.error === null,
          value: ev.value,
          render: null,
          error: ev.error,
          decision: null,
        });
        break;
      case "turn_end": {
        const phase = outcomePhase(ev.outcome);
        const error = ev.outcome !== undefined && typeof ev.outcome === "object" ? `${ev.outcome.error.kind}: ${ev.outcome.error.message}` : null;
        push("turn_end", { outcome: phase, error });
        push("status", { phase, error });
        break;
      }
    }
  }
  if (!sawTurnStart && frames.length > 0) turn = startTurn;
  return frames;
}
