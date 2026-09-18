/**
 * Core shared types for the Celestea TS rewrite.
 *
 * These mirror the frozen contracts 1:1:
 *  - SessionEvent / TurnOutcome : celestea_harness/crates/core/src/session_log.rs
 *  - SSE envelope + LoopEvent   : celestea_studio/src/main.rs:640-732
 *  - Studio message projection  : celestea_studio/src/api.rs:94-135
 *
 * Field names are contract, not style: do not rename anything here.
 */

import type { ImageRef } from "./message.js";

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
  /**
   * W804: content-addressed image references attached to this message. Omitted
   * entirely when there are none (serde style), so every pre-W804 row is
   * byte-identical; the bytes live in the session's attachments/ directory and
   * NEVER in the log.
   */
  attachments?: ImageRef[];
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
/**
 * W855 (B6): how the MODEL-VISIBLE face of a tool result is derived from the
 * log's ORIGINAL `value` at read time. The session log stores the original; the
 * projection (`projection.ts`) applies this descriptor. Keeping it on the row is
 * what makes a replay reproduce the live model context byte for byte (the
 * retention decision is a per-step budget outcome, not a pure function of the
 * value).
 */
export type ToolResultSurface =
  | {
      /** Retention replaced an oversized result with a bounded head/tail window. */
      kind: "omitted";
      omitted_bytes: number;
      total_bytes: number;
      locator: string;
      retrieval_hint: string;
      head_bytes: number;
      tail_bytes: number;
    }
  | {
      /** The tool itself truncated the result and authored a retrieval note. */
      kind: "truncation";
      note: string;
    };

export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  value: unknown;
  error: string | null;
  /** W255 run_code sub-call: present only for nested rows. */
  parent_id?: string;
  /** W855 (B6): the model-face descriptor; absent = project `value` as-is. */
  surface?: ToolResultSurface;
}

/**
 * W783 §7: the model ASKED the user something. A host-side audit row (the engine
 * never writes one) recording the request while the turn is parked, so a client
 * that reconnects can rebuild the card and a replay can see what was asked.
 */
export interface UserQuestionEvent {
  type: "user_question";
  /** Request id (`q-<n>`), echoed by the matching `user_answer` row. */
  id: string;
  /** The question batch as the model asked it. */
  questions: unknown[];
  /**
   * Absolute deadline in ms, judged at READ time (§6.1) — so a replay still
   * knows whether the question had expired, with no timer involved.
   */
  expires_at?: number;
  /** The resolved maximum wait in ms. */
  timeout_ms?: number;
}

/**
 * W783 §7: the question was answered (or expired). `answers` holds the same
 * items the tool returned, with `selected` as option LABELS.
 */
export interface UserAnswerEvent {
  type: "user_answer";
  /** The request id this row answers. */
  id: string;
  answers: unknown[];
  /** `true` = the deadline expired and no answer exists (§6.3). */
  timed_out?: boolean;
}

export type SessionEvent =
  | TurnStartEvent
  | TurnEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | UserQuestionEvent
  | UserAnswerEvent;

export const SESSION_EVENT_TYPES = [
  "turn_start",
  "turn_end",
  "user_message",
  "assistant_message",
  "thinking_delta",
  "tool_call",
  "tool_result",
  "user_question",
  "user_answer",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Studio message projection (GET /api/sessions/{id}/messages)
// ---------------------------------------------------------------------------

export interface UserMessageOut {
  role: "user";
  content: string;
  /**
   * W804: the attachments of this user message (references only). Omitted when
   * there are none, so every existing golden message stays byte-identical.
   */
  attachments?: ImageRef[];
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
  /** W855 (B6): the bounded/annotated model face when the row carries a `surface`. */
  tool_value: unknown;
  tool_error: string | null;
  tool_parent_id?: string;
  tool_surface?: ToolResultSurface;
}

/**
 * W783 §7: a question the model asked, as the transcript surface shows it.
 * `content` carries the raw batch the tool received.
 */
export interface QuestionAskedMessageOut {
  role: "question";
  kind: "question";
  /** Request id (`q-<n>`), matching the `user_answer` row. */
  question_id: string;
  content: unknown;
  /** Absolute deadline in ms (absent on a legacy/hand-written row). */
  question_expires_at?: number;
}

/**
 * W783 §7: the answer to a question (or the fact that it expired). `content`
 * carries the answer items, whose `selected` entries are option LABELS.
 */
export interface QuestionAnsweredMessageOut {
  role: "question";
  kind: "answer";
  question_id: string;
  content: unknown;
  /** `true` = the deadline expired; nothing was chosen on the model's behalf. */
  question_timed_out?: boolean;
}

export type StudioMessage =
  | UserMessageOut
  | AssistantMessageOut
  | ThinkingMessageOut
  | ToolCallMessageOut
  | ToolResultMessageOut
  | QuestionAskedMessageOut
  | QuestionAnsweredMessageOut;

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
  // W783: the model asked the user something and the turn is PARKED on it.
  "question",
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
  /**
   * W218/W754/W763 throughput estimate, in CHARACTERS per second (the frozen
   * field name is historical; the UI shows it as an approximate ~1:1 token rate).
   * The mean over "active" intervals only — no-flow breaks (> `GAP_MS` = 1s
   * between deltas: long tool calls, stalls, the idle tail of a finished turn)
   * never enter the denominator. It is the responsive 5s window rate while that
   * window still carries output, and the whole TURN's active-interval mean once
   * the window empties, so it stays a stable positive number after a stall or
   * after the turn ends. 0 means exactly one thing: this turn has produced no
   * text/thinking delta yet (TTFT). Reset by the next turn.
   */
  tokens_per_sec: number;
  context_usage: {
    used: number;
    window: number;
    ratio: number;
    /** W755: `used` is the visible-surface ESTIMATE, not a real provider sample. */
    estimated: boolean;
    /**
     * W755 source vocabulary:
     *   - `usage_prompt_tokens` the REAL prompt of a provider usage frame;
     *   - `assembled_estimate`  the token estimate of the loop's own next request
     *                           (system + trimmed history + tool schemas);
     *   - `none`                nothing measurable -> the UI shows "unknown";
     *   - `session_event_chars` RETIRED in v2.5.0 (the session log's CHARACTER
     *                           count was divided by a TOKEN window). Kept in the
     *                           union so a consumer can still recognise a payload
     *                           from an older build; never emitted any more.
     */
    method: "usage_prompt_tokens" | "session_event_chars" | "assembled_estimate" | "none";
    /**
     * W755 (Fix B): true when `used` carries the model-visible growth measured
     * after the prompt sample — i.e. it answers for the NEXT request rather than
     * the last one (DSH `projectedTokens`). Distinct from `estimated`.
     */
    projected: boolean;
    /**
     * W755 (Fix C): where `window` came from. `ratio` is a real measurement only
     * for `profile`; `fallback` (no declared capacity -> the 1,000,000 display
     * default applies) and `unknown` both report `window: 0, ratio: 0`.
     */
    window_source: "profile" | "fallback" | "unknown";
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
