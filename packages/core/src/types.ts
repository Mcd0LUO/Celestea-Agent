/**
 * Core shared types for the Celestea TS rewrite.
 *
 * These mirror the frozen Rust contracts 1:1:
 *  - SessionEvent / TurnOutcome : celestea_harness/crates/core/src/session_log.rs
 *  - SSE envelope + LoopEvent   : celestea_studio/src/main.rs:640-732
 *  - Studio message projection  : celestea_studio/src/api.rs:94-135
 *
 * Field names are contract, not style: do not rename anything here.
 */

// ---------------------------------------------------------------------------
// Session log (engine v1 JSONL)
// ---------------------------------------------------------------------------

/** The 5 real terminal states of a turn (never collapse these). */
export type TurnOutcome =
  | "completed"
  | "cancelled"
  | { error: { kind: "generate" | "stream"; message: string } }
  | "step_limit"
  | "interrupted";

export const TURN_OUTCOMES: readonly string[] = [
  "completed",
  "cancelled",
  "error",
  "step_limit",
  "interrupted",
] as const;

export interface TurnStartEvent {
  type: "turn_start";
  id: string;
}
export interface TurnEndEvent {
  type: "turn_end";
  id: string;
  /** Legacy rows omit it and deserialize as "completed". */
  outcome?: TurnOutcome;
}
export interface UserMessageEvent {
  type: "user_message";
  text: string;
}
export interface AssistantMessageEvent {
  type: "assistant_message";
  text: string;
}
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}
export interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
  /** W255 run_code sub-call: present only for nested rows. */
  parent_id?: string;
}
export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  value: unknown;
  error: string | null;
  /** W255 run_code sub-call: present only for nested rows. */
  parent_id?: string;
}

export type SessionEvent =
  | TurnStartEvent
  | TurnEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent;

export const SESSION_EVENT_TYPES = [
  "turn_start",
  "turn_end",
  "user_message",
  "assistant_message",
  "thinking_delta",
  "tool_call",
  "tool_result",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Studio message projection (GET /api/sessions/{id}/messages)
// ---------------------------------------------------------------------------

export interface UserMessageOut {
  role: "user";
  content: string;
}
export interface AssistantMessageOut {
  role: "assistant";
  content: string;
}
export interface ThinkingMessageOut {
  role: "thinking";
  content: string;
}
export interface ToolCallMessageOut {
  role: "tool";
  kind: "call";
  tool_call_id: string;
  tool_name: string;
  tool_args: unknown;
  tool_parent_id?: string;
}
export interface ToolResultMessageOut {
  role: "tool";
  kind: "result";
  tool_call_id: string;
  tool_value: unknown;
  tool_error: string | null;
  tool_parent_id?: string;
}

export type StudioMessage =
  | UserMessageOut
  | AssistantMessageOut
  | ThinkingMessageOut
  | ToolCallMessageOut
  | ToolResultMessageOut;

// ---------------------------------------------------------------------------
// SSE (GET /api/events)
// ---------------------------------------------------------------------------

export const SSE_EVENT_NAMES = [
  "text",
  "thinking",
  "tool",
  "tool_result",
  "turn_end",
  "done",
  "status",
  "compact",
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/**
 * `data:` field of every SSE frame.
 *
 * W513 extension (pure addition): `v` is the envelope version (2 = per-session
 * envelope; a missing `v` is a legacy 0 envelope) and `session` names the
 * session the frame belongs to (`null` = process-level frame, e.g. `lagged`).
 * `turn` is the SESSION-local turn number, `seq` stays process-global monotonic
 * and `payload` is unchanged.
 */
export interface SseEnvelope<P = unknown> {
  v: number;
  session: string | null;
  turn: number;
  seq: number;
  payload: P;
}

export const STATUS_PHASES = [
  "start",
  "progress",
  "completed",
  "cancelled",
  "error",
  "step_limit",
  "interrupted",
  "lagged",
] as const;

export type StatusPhase = (typeof STATUS_PHASES)[number];

export interface Statusline {
  model: string;
  reasoning_effort: string | null;
  steps: number;
  tokens_per_sec: number;
  context_usage: {
    used: number;
    window: number;
    ratio: number;
    estimated: boolean;
    method: "usage_prompt_tokens" | "session_event_chars";
  };
  usage: UsageBlock & { total: UsageBlock };
}

export interface UsageBlock {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  cache_hit_ratio: number;
  reasoning_tokens: number;
}

/** Engine loop events, mapped 1:1 onto SSE names by loop_event_to_json. */
export type LoopEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | {
      kind: "tool_result";
      callId: string;
      ok: boolean;
      value: unknown;
      render: unknown;
      error: string | null;
      decision: "allow" | "deny" | "ask" | null;
    }
  | { kind: "turn_end"; outcome: TurnOutcome }
  | { kind: "done"; text: string; tool_calls: Array<{ id: string; name: string; args: unknown }> };

// ---------------------------------------------------------------------------
// HTTP error envelope
// ---------------------------------------------------------------------------

export interface ErrorEnvelope {
  ok: false;
  error: string;
}

export interface OkEnvelope {
  ok: true;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string };

// ---------------------------------------------------------------------------
// Providers / workspaces / sessions (public views)
// ---------------------------------------------------------------------------

export interface ProviderModelPublic {
  id: string;
  name: string;
  reasoning_efforts: string[];
  context_window: number | null;
  max_output_tokens: number | null;
}

/** NOTE: `api_key` is intentionally absent from this type. */
export interface ProviderPublicView {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: "chat_completions" | "responses" | "anthropic_messages";
  models: ProviderModelPublic[];
  is_default: boolean;
  has_key: boolean;
}

export interface ProvidersView {
  providers: ProviderPublicView[];
  default_model: string | null;
}

export interface WorkspaceView {
  name: string;
  path: string;
  sessions: number;
}

export interface WorkspacesView {
  workspaces: WorkspaceView[];
  active_session: string | null;
}

export interface SessionSummary {
  id: string;
  workspace: string;
  title: string;
  model: string | null;
  size: number;
  modified: number;
  active: boolean;
  kind?: "worker";
}

export interface SessionsView {
  sessions: SessionSummary[];
  active_session: string | null;
}

// ---------------------------------------------------------------------------
// Workers (registry.tsv)
// ---------------------------------------------------------------------------

export const WORKER_STATUSES = ["RUNNING", "DONE", "FAILED"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface WorkerEntry {
  wid: string;
  started_at: string;
  status: WorkerStatus;
  extra: string;
}
