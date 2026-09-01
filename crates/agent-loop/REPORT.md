# celestea-agent-loop (W104) — Implementation Report

## Files created / modified

- `crates/agent-loop/src/lib.rs` — implemented `DefaultAgentLoop` (only file written).
- `crates/agent-loop/REPORT.md` — this report.

## What was implemented

`DefaultAgentLoop` implements the pinned `celestea_core::AgentLoop` seam exactly as
specified in ARCHITECTURE.md:

- `pub struct DefaultAgentLoop { config: AgentConfig, turn_id: AtomicU64 }`.
- `DefaultAgentLoop::new(config: AgentConfig) -> Self`.
- `#[async_trait] impl AgentLoop for DefaultAgentLoop` with
  `async fn run_turn(&self, ctx, user_input) -> Result<(), AgentError>`.

`run_turn` follows the required turn flow:

1. Resolve `LlmService`, `SessionService`, `ToolRegistryService` from `ctx`;
   any missing service returns an `AgentError`.
2. Allocate a monotonic turn id via `AtomicU64` (no new dependency), then append
   `TurnStart { id }` and `UserMessage { text }`.
3. Loop up to `config.max_steps` times:
   - `messages = session.derive_messages()`.
   - Build `ModelRequest { model, system: Some(system_prompt), messages,
     tools: registry.schemas(), max_tokens: None, temperature: None }`.
   - `llm.generate(req)` then consume the stream with `futures_util::StreamExt`.
   - `StreamEvent::Text` deltas are printed to stdout and flushed.
   - `StreamEvent::Done(message)` is collected: `Content::Text` fragments are
     concatenated into `assistant_text`; `Content::ToolCall` entries are gathered
     into `tool_calls`.
   - If there are no tool calls, append `AssistantMessage { text }` and break.
   - Otherwise: first append ALL `ToolCall { id, name, args }` events (they form
     one assistant message in the LLM protocol), THEN dispatch each call via
     `registry.dispatch(ToolInput { call_id, name, args })` and append its
     `ToolResult { id: output.call_id, value: output.value, error: output.error }`.
     This avoids interleaving ToolCall/ToolResult per call; then continue to the
     next loop iteration.
4. Append `TurnEnd { id }` and return `Ok(())`.

## Key implementation notes

- `DefaultAgentLoop` stays `Send + Sync` by using `AtomicU64` for the turn id
  counter (interior mutability without a lock).
- Stdout printing failures are ignored (`let _ = ...`) so a broken pipe cannot
  abort the turn; this is the right call for a streamed-UI driver.
- Tool results use `ToolOutput.call_id` as the `ToolResult.id`, which lets the
  session layer match results to calls (the log's `ToolResult.id` is not required
  to equal the model's `ToolCall.id`, but call_id is the natural key).
- Multi-tool-call ordering respects the LLM protocol: all `ToolCall` events of a
  single assistant step are appended together BEFORE any `ToolResult`, so a
  session-layer `derive_messages` can group them into one assistant message
  followed by the individual tool-result messages. Dispatch still happens per
  call and appends results in the same order.
- No tool-call parallel fan-out was implemented: the MVP dispatches calls
  sequentially even though `config.max_parallel_tool_calls` exists. See below.

## Build verification

`cargo build -p celestea-agent-loop` from the repo root: **PASSED** (exit code 0,
no warnings, no errors). Re-verified after the tool-call/tool-result ordering
fix.

## Assumptions / open items

- `config.max_parallel_tool_calls` is currently unused: tool calls are dispatched
  sequentially in the order the model returns them. Parallel dispatch is a later
  enhancement and was intentionally left out to keep the MVP simple and correct.
- In the tool-call branch the assistant's accompanying text (if any) is not
  appended as an `AssistantMessage`; the flow strictly follows ARCHITECTURE.md,
  which only appends `AssistantMessage` in the no-tool-call case. If the model
  emits both text and tool calls in one step, that text is discarded from the
  log (though the model still sees tool results on the next iteration).
- No extra dependencies were required; all needed crates (async-trait, tokio,
  futures-util, serde_json, celestea-core) were already pinned in Cargo.toml.

