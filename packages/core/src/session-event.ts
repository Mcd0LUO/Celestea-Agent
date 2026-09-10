/**
 * SessionEvent codec — the serde-exact JSONL row contract of
 * `crates/core/src/session_log.rs:44-85`.
 *
 * Wire rules (all of them are contract):
 *   - internally tagged enum: the `type` key comes FIRST, then the fields in
 *     declaration order (`id`, `outcome` / `id`, `name`, `args`, `parent_id`);
 *   - `parent_id` is `Option<String>` with `skip_serializing_if = "Option::is_none"`,
 *     so it is omitted when absent (pre-W255 byte shape) — but a JSON `null`
 *     also deserializes to `None`;
 *   - `value` / `error` are `Option<…>` without skip: they are ALWAYS written
 *     and become `null` when absent;
 *   - `TurnEnd.outcome` has `#[serde(default)]`: a legacy row without it reads
 *     as `"completed"` and is re-written WITH the field;
 *   - unknown fields are ignored; a missing required field or an unknown
 *     `type` is a parse error (the caller then treats the row as a torn tail);
 *   - `args` / `value` ride through `serde_json::Value`, so their object keys
 *     are re-serialized in sorted order (see `serdeJsonString`).
 */

import { isRecord, serdeJsonString } from "./json.js";
import { SESSION_EVENT_TYPES, type SessionEvent, type SessionEventType, type TurnOutcome } from "./types.js";

export type ValidateResult = { ok: true; event: SessionEvent } | { ok: false; errors: string[] };

/** `TurnOutcome::default()` — legacy `turn_end` rows read as completed. */
export const DEFAULT_TURN_OUTCOME: TurnOutcome = "completed";

/** The outcome of a row, with the legacy default applied. */
export function effectiveOutcome(o: TurnOutcome | undefined): TurnOutcome {
  return o === undefined ? DEFAULT_TURN_OUTCOME : o;
}

/** Normalized outcome label (TurnOutcome -> the 5 SSE/statusline phases). */
export function outcomePhase(o: TurnOutcome | undefined): string {
  const e = effectiveOutcome(o);
  return typeof e === "string" ? e : "error";
}

/** `"{kind}: {message}"` for the error variant, null otherwise. */
export function outcomeError(o: TurnOutcome | undefined): string | null {
  const e = effectiveOutcome(o);
  return typeof e === "string" ? null : `${e.error.kind}: ${e.error.message}`;
}

/** The error payload of the error variant, null otherwise. */
export function outcomeErrorParts(o: TurnOutcome | undefined): { kind: string; message: string } | null {
  const e = effectiveOutcome(o);
  return typeof e === "string" ? null : e.error;
}

export function isTurnOutcome(v: unknown): v is TurnOutcome {
  if (typeof v === "string") return ["completed", "cancelled", "step_limit", "interrupted"].includes(v);
  if (isRecord(v) && isRecord(v["error"])) {
    const e = v["error"];
    return typeof e["kind"] === "string" && typeof e["message"] === "string";
  }
  return false;
}

export function isSessionEventType(t: string): t is SessionEventType {
  return (SESSION_EVENT_TYPES as readonly string[]).includes(t);
}

/** Validate one decoded JSON value against the SessionEvent contract. */
export function validateSessionEvent(raw: unknown): ValidateResult {
  if (!isRecord(raw)) return { ok: false, errors: ["event is not a JSON object"] };
  const type = raw["type"];
  if (typeof type !== "string") return { ok: false, errors: ["missing string field `type`"] };
  if (!isSessionEventType(type)) return { ok: false, errors: [`unknown event type '${type}'`] };

  const errors: string[] = [];
  switch (type) {
    case "turn_start":
      requireString(raw, "id", errors);
      break;
    case "turn_end":
      requireString(raw, "id", errors);
      if (raw["outcome"] !== undefined && raw["outcome"] !== null && !isTurnOutcome(raw["outcome"])) {
        errors.push("field 'outcome' is not a valid TurnOutcome");
      }
      break;
    case "user_message":
    case "assistant_message":
    case "thinking_delta":
      requireString(raw, "text", errors);
      break;
    case "tool_call":
      requireString(raw, "id", errors);
      requireString(raw, "name", errors);
      requirePresent(raw, "args", errors);
      optionalString(raw, "parent_id", errors);
      break;
    case "tool_result":
      requireString(raw, "id", errors);
      // value / error are `Option<_>`: absent == null (serde treats Option
      // fields as optional), so only their type is checked when present.
      if (raw["error"] !== undefined && raw["error"] !== null && typeof raw["error"] !== "string") {
        errors.push("field 'error' must be string|null");
      }
      optionalString(raw, "parent_id", errors);
      break;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, event: normalizeSessionEvent(raw, type) };
}

/** Parse one JSONL row; a failure is the caller's torn-tail signal. */
export function parseSessionEvent(line: string): ValidateResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line) as unknown;
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  return validateSessionEvent(decoded);
}

/** `Option<T>` normalisation: a JSON `null` is `None`, i.e. absent. */
function normalizeSessionEvent(raw: Record<string, unknown>, type: SessionEventType): SessionEvent {
  if (type === "tool_call") {
    const ev: SessionEvent = {
      type,
      id: raw["id"] as string,
      name: raw["name"] as string,
      args: raw["args"],
    };
    const parent = nullableString(raw["parent_id"]);
    if (parent !== undefined) ev.parent_id = parent;
    return ev;
  }
  if (type === "tool_result") {
    const ev: SessionEvent = {
      type,
      id: raw["id"] as string,
      value: raw["value"],
      error: nullableString(raw["error"]) ?? null,
    };
    const parent = nullableString(raw["parent_id"]);
    if (parent !== undefined) ev.parent_id = parent;
    return ev;
  }
  if (type === "turn_end") {
    // `#[serde(default)]` fills the missing outcome on the Rust side, so the
    // in-memory event ALWAYS carries one (a legacy row reads as completed).
    return { type, id: raw["id"] as string, outcome: effectiveOutcome(raw["outcome"] as TurnOutcome | undefined) };
  }
  return raw as unknown as SessionEvent;
}

function nullableString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function requireString(raw: Record<string, unknown>, name: string, errors: string[]): void {
  if (typeof raw[name] !== "string") errors.push(`field '${name}' must be a string`);
}

function requirePresent(raw: Record<string, unknown>, name: string, errors: string[]): void {
  if (!(name in raw)) errors.push(`field '${name}' is required`);
}

function optionalString(raw: Record<string, unknown>, name: string, errors: string[]): void {
  const v = raw[name];
  if (v !== undefined && v !== null && typeof v !== "string") {
    errors.push(`field '${name}' must be a string when present`);
  }
}

/**
 * Serialize one event exactly like `serde_json::to_string(&SessionEvent)`:
 * the `type` tag first, then the fields in declaration order, `parent_id`
 * omitted when None, `value` / `error` always present (null when None), and
 * `outcome` always present (legacy rows are normalised to `"completed"`).
 *
 * The event struct order is preserved (serde writes struct fields in
 * declaration order); only the `Value`-typed fields (`args`, `value`) go
 * through the sorted-key `serdeJsonString`, exactly like serde_json's BTreeMap.
 */
export function serializeSessionEvent(ev: SessionEvent): string {
  const parts: string[] = [`"type":${JSON.stringify(ev.type)}`];
  switch (ev.type) {
    case "turn_start":
      parts.push(`"id":${JSON.stringify(ev.id)}`);
      break;
    case "turn_end":
      parts.push(`"id":${JSON.stringify(ev.id)}`);
      parts.push(`"outcome":${serializeOutcome(ev.outcome)}`);
      break;
    case "user_message":
    case "assistant_message":
    case "thinking_delta":
      parts.push(`"text":${JSON.stringify(ev.text)}`);
      break;
    case "tool_call":
      parts.push(`"id":${JSON.stringify(ev.id)}`);
      parts.push(`"name":${JSON.stringify(ev.name)}`);
      parts.push(`"args":${serdeJsonString(ev.args)}`);
      if (ev.parent_id !== undefined && ev.parent_id !== null) parts.push(`"parent_id":${JSON.stringify(ev.parent_id)}`);
      break;
    case "tool_result":
      parts.push(`"id":${JSON.stringify(ev.id)}`);
      parts.push(`"value":${serdeJsonString(ev.value === undefined ? null : ev.value)}`);
      parts.push(`"error":${ev.error === undefined || ev.error === null ? "null" : JSON.stringify(ev.error)}`);
      if (ev.parent_id !== undefined && ev.parent_id !== null) parts.push(`"parent_id":${JSON.stringify(ev.parent_id)}`);
      break;
  }
  return `{${parts.join(",")}}`;
}

/** `TurnOutcome` serde shape: `"completed"` | … | `{"error":{"kind","message"}}`. */
function serializeOutcome(o: TurnOutcome | undefined): string {
  const e = effectiveOutcome(o);
  if (typeof e === "string") return JSON.stringify(e);
  return `{"error":{"kind":${JSON.stringify(e.error.kind)},"message":${JSON.stringify(e.error.message)}}}`;
}
