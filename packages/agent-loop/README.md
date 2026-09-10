# @celestea/agent-loop

The `AgentLoop` implementation: turn/step driving, context-budget trimming,
cooperative cancellation and the five real terminal states. Depends only on
`@celestea/core`; every collaborator (`Llm`, `SessionLog`, `ToolRegistry`) is
resolved from the `Context` at turn start, so this package never imports a
provider, a storage backend or a tool implementation.

Ports (1:1 against the Rust engine unless listed under **Divergences**):

| TS module | Rust source |
|---|---|
| `loop.ts` (`DefaultAgentLoop`, the step loop) | `crates/agent-loop/src/loop.rs` (`impl AgentLoop for DefaultAgentLoop`) |
| `step.ts` (per-step verdict types + folds) | inline in `loop.rs` |
| `seams.ts` (Context → Llm/SessionLog/ToolRegistry) | `loop.rs:204-213` |
| `cancel.ts` (checkpoints, synthetic result text) | `loop.rs:177-200` (`cancel_set` / `wait_cancel`, W267 constant) |
| `context-trim.ts` (`estimate_*`, `trim_context`) | `crates/agent-loop/src/context.rs` (W220) |
| `usage.ts` (`UsageTracker`) | `loop.rs:49-89` (W220) |
| `events.ts` (`LoopEvent` builders + `EventSink`) | `crates/agent-loop/src/events.rs` |
| `thinking.ts` (W252 thinking-burst aggregation) | `loop.rs:165-171` (`flush_thinking`) |
| `plugin.ts` (`AGENT_LOOP_SERVICE` registration) | `crates/runtime/src/compose.rs:208-220` |
| `sse.ts` (`LoopEvent` → SSE frame) | `celestea_studio/src/main.rs:667-713` (`loop_event_to_json`) |

## Public API (via `index.ts` only)

- **Loop** — `DefaultAgentLoop` (implements core's `AgentLoop`), with
  `runTurn(ctx, input)` for the seam and `runTurnOutcome(ctx, input)` for hosts
  that want the terminal state back; `AgentLoopBindings` = `{ signal?, sink?,
  usage? }`; read-only `agentConfig` / `usageTracker` accessors.
- **Plugin** — `agentLoopPlugin(config, bindings?, name?)` provides a loop under
  core's `AGENT_LOOP_SERVICE` token; `createAgentLoop(config, bindings?)` builds
  one without a Context. Mounting order is patch semantics: a later mount wins.
- **Cancellation** — `CANCELLED_BEFORE_EXECUTION`, `raceAbort(signal, work)`,
  `isAborted(signal)`, `closeIterator(iter)`, `errorMessage(err)`, `RaceResult`.
- **Context budget** — `trimContext(messages, systemTokens, windowTokens,
  threshold, keepRecent)` → `{ messages, outcome }`, `estimateTokens`,
  `estimateMessageTokens`, `estimateMessagesTokens`, `trimmedMarkerMessage`,
  `TrimOutcome`, `TrimResult`, `TRIMMED_MARKER_PREFIX`.
- **Usage** — `UsageTracker` (`record` / `latest` / `total`) and
  `createUsageTracker()`.
- **Events** — `EventSink`, `toolCallEvent`, `toolResultEvent`, `doneEvent`,
  `turnEndEvent`, `decisionLabel`.
- **SSE** — `loopEventToSse(event)` → `{ event, payload }` (`SseFrame`).

## Turn semantics (the five terminal states)

One turn = `turn_start` + `user_message`, then up to `max_steps` model steps,
then **exactly one** `turn_end`, written to the log and emitted to the sink from
a single exit point. `max_steps === 0` means unlimited (W220). The terminal
state is one of:

| state | when |
|---|---|
| `completed` | the model answered without tool calls |
| `cancelled` | the `AbortSignal` fired at any checkpoint |
| `error{kind}` | `generate` failed before the stream, or `stream` failed mid-flight |
| `step_limit` | the step budget ran out without a final answer — **never** `completed` |
| `interrupted` | the stream ended without a terminal frame (torn/EOF) |

A partial answer is never flushed as a reply, and `runTurn` only rejects with
`AgentError` when the Context is missing a driver seam (`missing LlmService in
context` / `missing SessionLog service in context` / `missing ToolRegistryService
in context`) — terminal states always ride the log.

Log ordering contracts (same as Rust):

- all `tool_call` rows of a step precede every `tool_result` row of that step;
- results are appended in the model's call order even when dispatched in
  parallel batches of `max_parallel_tool_calls` (clamped to ≥ 1);
- thinking bursts are persisted **before** the reply / tool calls they precede;
- derived history comes from `SessionLog.deriveMessages()` only — the loop never
  keeps a second copy of the conversation. Tool-call merging is `session`'s job.

## Cancellation

Cooperative over an `AbortSignal`, re-checked at every await checkpoint:
before generating, while consuming the stream (each `next()`), and while a tool
batch is in flight. On a mid-dispatch cancel, every call of the step that has no
real result yet gets a synthesized `tool_result` with
`error = "cancelled before execution"` (W267), appended after the real results
and before `turn_end`, in model order — the log stays protocol-valid (no
dangling assistant `tool_calls`), and the sink receives the paired event.

`raceAbort` never rejects: a rejected `work` returns `{ outcome: "failed" }`, so
the loop keeps its state contract instead of leaking a seam exception. The
abandoned provider stream is closed via `closeIterator`.

## Thinking aggregation (W252) and deferred Done

Streamed reasoning deltas are concatenated and flushed as **one**
`thinking_delta` row per contiguous burst (boundaries: text / done / failed /
interrupted / stream end / cancel); the live `thinking` event is still emitted
per delta. The `done` event is **deferred until the stream truly ends**, so
trailing reasoning that providers send after the finish frame still lands above
the reply on the wire.

## Usage

Bind a `UsageTracker` and every `usage` stream event is recorded: `latest()` is
the most recent response, `total()` the cumulative sum (detached copies, Rust
`Copy` semantics). Without a tracker, `usage` events are consumed and ignored.

## Extension points

```ts
import { Context, mountPlugins, SESSION_LOG_SERVICE, TOOL_REGISTRY_SERVICE, LLM_SERVICE } from "@celestea/core";
import { agentLoopPlugin, defaultAgentConfig, createUsageTracker } from "@celestea/agent-loop";

const usage = createUsageTracker();
const ctx = Context.root();
// …mount the llm / session / tools plugins first (they provide the seams)…
mountPlugins(ctx, [agentLoopPlugin(defaultAgentConfig({ max_steps: 32 }), { usage, signal: abort.signal, sink })]);
```

- **Another provider / storage / tool set** — mount a different plugin; this
  package needs no change (no `if (provider === …)` anywhere).
- **Another event transport** — pass your own `EventSink`; without one, events
  are dropped (the host owns rendering).
- **Another cancellation source** — pass any `AbortSignal` (HTTP request, CLI
  ctrl-c, a worker watchdog); one controller can abort exactly one turn.
- **Another trimming policy** — `trimContext` is a pure function; call it
  directly or replace the call site in `buildRequest`.

## Divergences from Rust (deliberate, all documented in code)

1. **Cancel signal**: `AbortSignal` owned by the caller instead of a
   `tokio::sync::watch::Receiver` built by the loop.
2. **No legacy stdout printer**: a missing sink drops events instead of printing
   `text` / `[thinking] …` (product code must not write to stdout —
   ARCHITECTURE.md §6.3).
3. **`max_steps = 0` is unlimited** here (W220 semantics); the studio's
   `MIN_STEPS = 4096` clamp belongs to the host, not the loop.
4. **Trim marker text** is a single-spaced sentence; Rust's literal carries the
   source indentation as runs of spaces. Contract-relevant part
   (`[context-trimmed]`, counts, token estimate) is identical.
5. **Torn stream after a `done` frame** ends the turn (with the stream's terminal
   state) instead of dispatching that step's tool calls under a sticky error
   outcome — a protocol-violating input that must not look successful.
6. **Seam violation on dispatch**: a registry that throws is contained as a
   `tool_result` error (Rust would unwind), so the turn still reaches a terminal
   state; a batch that somehow rejects is reported as `AgentError`.

### P0 placeholder cleanup

The P0 skeleton of this package exported `outcomePhase` / `outcomeError`
(duplicates of `core`'s, now imported from there), plus `MIN_STEPS`,
`STATUS_TICK_MS` and `createCancelSignal` — host-side loop scaffolding. All of
them moved out in P1b: the five-state vocabulary lives in `core`, cancellation
is an `AbortSignal` owned by the caller, and the studio's step clamp belongs to
`apps/studio`. `loopEventToSse` kept its signature and now lives in `sse.ts`.

## Tests

`pnpm vitest run packages/agent-loop` — 56 cases across 7 files, all against
fake `Llm` / `SessionLog` / `ToolRegistry` seam doubles (no network, no disk):
`context-trim.test.ts` (estimate + trim matrix), `usage.test.ts`,
`loop.test.ts` (stepping, five terminal states, TurnEnd uniqueness, deferred
Done, thinking aggregation, unique turn ids), `loop-tools.test.ts` (dispatch
order, batch concurrency, request building/trimming, usage), `cancel.test.ts`
(before the turn / mid-stream / mid-dispatch + W267 synthesis),
`events.test.ts` (builders + SSE mapping), `plugin.test.ts` (service token).

## File layout

```
src/index.ts          public API (module map + re-exports)
src/loop.ts           DefaultAgentLoop: turn bookkeeping + step loop
src/step.ts           StepResult / GenerateResult / StreamOutcome + folds
src/seams.ts          Context -> Llm / SessionLog / ToolRegistry, safe dispatch
src/cancel.ts         AbortSignal checkpoints + W267 constant
src/context-trim.ts   token estimate + trim_context
src/usage.ts          UsageTracker
src/events.ts         LoopEvent builders + EventSink
src/thinking.ts       thinking-burst buffer (W252)
src/plugin.ts         AGENT_LOOP_SERVICE registration
src/sse.ts            LoopEvent -> SSE frame (contracts/sse-events.json)
src/fakes.test-util.ts  seam doubles + turn harness for the tests
```

Size policy: every file ≤ 400 lines (max 292), every function ≤ 80 lines, no
`ARCH_EXCEPTIONS` entry. `pnpm check` (typecheck + lint + lint:arch + test) is
the gate.
