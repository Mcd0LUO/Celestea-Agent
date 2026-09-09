/**
 * cli-main.jsonl parsing/serialization.
 *
 * Contract: one SessionEvent per line; blank lines skipped; parsing STOPS at the
 * first unparsable line (a torn tail is never treated as content) —
 * src/api.rs:141-153.
 */

import { isRecord, type ParseFailure } from "@celestea/core";
import {
  SESSION_EVENT_TYPES,
  type SessionEvent,
  type SessionEventType,
  type TurnOutcome,
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
  physicalLines: number;
  blankLines: number;
  /** Lines successfully parsed into events. */
  parsedLines: number;
  /** Everything from the first unparsable line onwards is ignored. */
  tornTail: TornTail | null;
}

export type ValidateResult =
  | { ok: true; event: SessionEvent }
  | { ok: false; errors: string[] };

function isOutcome(v: unknown): v is TurnOutcome {
  if (typeof v === "string") return ["completed", "cancelled", "step_limit", "interrupted"].includes(v);
  if (isRecord(v) && isRecord(v["error"])) {
    const e = v["error"];
    return typeof e["kind"] === "string" && typeof e["message"] === "string";
  }
  return false;
}

/** Validate one decoded JSON value against the SessionEvent contract. */
export function validateSessionEvent(raw: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["event is not a JSON object"] };
  const type = raw["type"];
  if (typeof type !== "string") return { ok: false, errors: ["missing string field `type`"] };
  if (!(SESSION_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, errors: [`unknown event type '${type}'`] };
  }
  const t = type as SessionEventType;
  const needString = (name: string): void => {
    if (typeof raw[name] !== "string") errors.push(`field '${name}' must be a string`);
  };
  const optionalString = (name: string): void => {
    const v = raw[name];
    if (v !== undefined && v !== null && typeof v !== "string") errors.push(`field '${name}' must be a string when present`);
  };

  switch (t) {
    case "turn_start":
    case "turn_end":
      needString("id");
      break;
    case "user_message":
    case "assistant_message":
    case "thinking_delta":
      needString("text");
      break;
    case "tool_call":
      needString("id");
      needString("name");
      if (!("args" in raw)) errors.push("field 'args' is required");
      optionalString("parent_id");
      break;
    case "tool_result":
      needString("id");
      if (!("value" in raw)) errors.push("field 'value' is required");
      if (!("error" in raw)) errors.push("field 'error' is required");
      if (raw["error"] !== null && typeof raw["error"] !== "string") errors.push("field 'error' must be string|null");
      optionalString("parent_id");
      break;
  }
  if (t === "turn_end") {
    const outcome = raw["outcome"];
    if (outcome !== undefined && !isOutcome(outcome)) {
      errors.push("field 'outcome' is not a valid TurnOutcome");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, event: raw as unknown as SessionEvent };
}

export function parseSessionJsonl(text: string): ParseJsonlResult {
  const lines = text.split("\n");
  // A trailing newline produces a final empty element; it is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const events: SessionEvent[] = [];
  let blankLines = 0;
  let tornTail: TornTail | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") {
      blankLines += 1;
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch (e) {
      tornTail = { line: i + 1, raw, error: e instanceof Error ? e.message : String(e) };
      break;
    }
    const v = validateSessionEvent(decoded);
    if (!v.ok) {
      tornTail = { line: i + 1, raw, error: v.errors.join("; ") };
      break;
    }
    events.push(v.event);
  }
  return { events, physicalLines: lines.length, blankLines, parsedLines: events.length, tornTail };
}

export type SerializeResult = { ok: true; line: string } | ParseFailure;

/**
 * Serialize with serde-compatible field order and `parent_id` omission
 * (skip_serializing_if = Option::is_none) so pre-W255 byte shape is preserved.
 */
export function serializeSessionEvent(ev: SessionEvent): string {
  const out: Record<string, unknown> = { type: ev.type };
  switch (ev.type) {
    case "turn_start":
      out["id"] = ev.id;
      break;
    case "turn_end":
      out["id"] = ev.id;
      if (ev.outcome !== undefined) out["outcome"] = ev.outcome;
      break;
    case "user_message":
    case "assistant_message":
    case "thinking_delta":
      out["text"] = ev.text;
      break;
    case "tool_call":
      out["id"] = ev.id;
      out["name"] = ev.name;
      out["args"] = ev.args;
      if (ev.parent_id !== undefined) out["parent_id"] = ev.parent_id;
      break;
    case "tool_result":
      out["id"] = ev.id;
      out["value"] = ev.value;
      out["error"] = ev.error;
      if (ev.parent_id !== undefined) out["parent_id"] = ev.parent_id;
      break;
  }
  return JSON.stringify(out);
}

export function serializeSessionJsonl(events: readonly SessionEvent[]): string {
  return events.map(serializeSessionEvent).join("\n") + (events.length > 0 ? "\n" : "");
}

/** Normalized outcome label (TurnOutcome -> the 5 SSE phases). */
export function outcomePhase(o: TurnOutcome | undefined): string {
  if (o === undefined) return "completed"; // legacy default
  if (typeof o === "string") return o;
  return "error";
}

export function outcomeError(o: TurnOutcome | undefined): string | null {
  if (o !== undefined && typeof o === "object") return `${o.error.kind}: ${o.error.message}`;
  return null;
}
