/**
 * cli-main.jsonl parsing/serialization (file level).
 *
 * Contract: one SessionEvent per line; blank lines are padding; parsing STOPS at
 * the first unparsable line (a torn tail is never treated as content) —
 * src/api.rs:141-153. The per-row codec (validate / serde-exact serialize) and
 * the TurnOutcome helpers live in `@celestea/core` (`session-event.ts`) and are
 * re-exported here so existing imports keep working.
 *
 * "Blank" is a truly empty line (or a lone `\r`), matching the Rust replay
 * (`record.is_empty()`); a whitespace-only line is an unparsable record.
 */

import { parseSessionEvent, serializeSessionEvent, type SessionEvent } from "@celestea/core";

export {
  DEFAULT_TURN_OUTCOME,
  effectiveOutcome,
  isSessionEventType,
  isTurnOutcome,
  outcomeError,
  outcomeErrorParts,
  outcomePhase,
  parseSessionEvent,
  serializeSessionEvent,
  validateSessionEvent,
  type ValidateResult,
} from "@celestea/core";

export interface TornTail {
  /** 1-based line number of the first unparsable line. */
  line: number;
  raw: string;
  error: string;
}

export interface ParseJsonlResult {
  events: SessionEvent[];
  /** Total physical lines in the input. */
  lines: string[];
  physicalLines: number;
  blankLines: number;
  /** Lines successfully parsed into events. */
  parsedLines: number;
  /** Everything from the first unparsable line onwards is ignored. */
  tornTail: TornTail | null;
}

/** Strip one trailing `\r` (`trim_line_end`); the `\n` is already consumed. */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function parseSessionJsonl(text: string): ParseJsonlResult {
  const lines = text.split("\n");
  // A trailing newline produces a final empty element; it is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const events: SessionEvent[] = [];
  let blankLines = 0;
  let tornTail: TornTail | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = stripCr(lines[i] ?? "");
    if (raw === "") {
      blankLines += 1;
      continue;
    }
    const parsed = parseSessionEvent(raw);
    if (!parsed.ok) {
      tornTail = { line: i + 1, raw, error: parsed.errors.join("; ") };
      break;
    }
    events.push(parsed.event);
  }
  return { events, lines, physicalLines: lines.length, blankLines, parsedLines: events.length, tornTail };
}

export function serializeSessionJsonl(events: readonly SessionEvent[]): string {
  return events.map((ev) => serializeSessionEvent(ev)).join("\n") + (events.length > 0 ? "\n" : "");
}
