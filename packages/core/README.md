# @celestea/core

The semantic kernel of the TypeScript rewrite: the frozen contract types, the
model-visible message model, the serde-exact `SessionEvent` codec, and the
plugin seams every other package is built on.

Ports (1:1, field names are contract):

| TS module | Rust source |
|---|---|
| `message.ts` | `crates/core/src/message.rs` (Role / Content / ToolCall / Message / Usage) |
| `stream.ts` | `crates/core/src/message.rs` + `llm.rs` (ModelRequest / StreamEvent / LlmError) |
| `session-event.ts` | `crates/core/src/session_log.rs` (SessionEvent serde, TurnOutcome) |
| `session-log.ts` | `crates/core/src/session_log.rs` (SessionLog trait) |
| `plugin.ts` | `crates/core/src/plugin.rs` (+ `registry.rs` NamedRegistry) |
| `context.ts` | `crates/core/src/context.rs` |
| `event-bus.ts` | `crates/core/src/event_bus.rs` |
| `llm.ts` | `crates/core/src/llm.rs` |
| `tool.ts` | `crates/core/src/tool.rs` |
| `agent.ts` | `crates/core/src/agent.rs` |
| `types.ts` | P0 frozen contracts (SSE envelope, endpoints, providers, workers) |

## Dependency rule

**`core` imports nothing from the other packages.** It declares seams only; the
concrete implementations live in sibling packages and are plugged in at compose
time (`examples` below). Consumers import from the package root
(`@celestea/core`) — never a deep path.

## Public API (via `index.ts` only)

- **Data model** — `Role`, `Content`, `ToolCall`, `Message` (+ `Message.user`,
  `Message.assistantText`, `Message.assistantToolCall`, `Message.toolResult`),
  helpers (`messageText`, `messageToolCalls`, `toolCallIds`, `hasToolCalls`),
  `Usage` (`usageAdd`, `usageSum`, `usageIsEmpty`, `cacheHitRatio`),
  `ToolSpec` / `ToolDecision` (in `types.ts`).
- **SessionEvent** — the union in `types.ts`; `validateSessionEvent`,
  `parseSessionEvent`, `serializeSessionEvent` (serde-exact: tag first,
  declaration order, `parent_id` omitted when absent, `value`/`error`/`outcome`
  always written), `effectiveOutcome`, `outcomePhase`, `outcomeError`.
- **Seams** — `Plugin`, `Context`, `EventBus`, `SessionLog`, `Llm`, `Tool`,
  `ToolGuard`, `ToolRegistry`, `AgentLoop`, plus the well-known service tokens
  `SESSION_LOG_SERVICE`, `EVENT_BUS_SERVICE`, `LLM_SERVICE`,
  `LLM_REGISTRY_SERVICE`, `TOOL_REGISTRY_SERVICE`, `TOOL_GUARD_SERVICE`,
  `AGENT_LOOP_SERVICE`.
- **JSON** — `serdeJsonString` (serde_json-compatible text: sorted object keys,
  `None` → `null`), `firstJsonDiff`, `stableStringify`.
- **SSE bus** — `createSseBus` / `SseBus` (SDK-side broadcast; renamed from the
  P0 `EventBus` so `EventBus` now means the engine seam).

## Extension points (everything is a plugin)

```ts
import { Context, mountPlugins, SESSION_LOG_SERVICE, definePlugin } from "@celestea/core";
import { inMemorySessionLogPlugin } from "@celestea/session";

const ctx = mountPlugins(Context.root(), [
  definePlugin("my-events", (c) => c.provide(EVENT_BUS_SERVICE, createEventBus())),
  inMemorySessionLogPlugin(),
]);

const log = ctx.require(SESSION_LOG_SERVICE);   // SessionLog seam, not a concrete class
const scoped = ctx.scoped();                    // per-agent scope, falls back to the parent
```

Registration is append-only with **last-wins** semantics (`Context.provide`,
`NamedRegistry`, `LlmRegistry`), so a test or a preset can shadow a service
without touching the composition root. `EventBus` has three independent modes:
`on`/`emit` (broadcast), `bail`/`runBail` (first non-`undefined` answer
short-circuits) and `waterfall`/`runWaterfall` (transform chain).

## File layout

```
src/types.ts         303  P0 frozen contracts (SessionEvent union, SSE, endpoints)
src/session-event.ts 216  serde-exact SessionEvent codec + TurnOutcome helpers
src/redact.ts        204  fixture/report secret redaction (P0)
src/message.ts       188  Role / Content / ToolCall / Message / Usage
src/contracts/       163  frozen contract-file loaders
src/json.ts          132  JSON helpers + serde_json-compatible text
src/sse-bus.ts       109  SDK-side SSE broadcast bus
src/event-bus.ts     102  engine EventBus seam
src/tool.ts           70  Tool / ToolGuard / ToolRegistry seams
src/context.ts        66  Context service container
src/plugin.ts         64  Plugin seam + NamedRegistry
src/stream.ts         56  ModelRequest / StreamEvent / LlmError
src/agent.ts          50  AgentLoop seam + AgentConfig
src/llm.ts            43  Llm seam + LlmRegistry
src/session-log.ts    34  SessionLog seam
src/index.ts          46  the only public entry point
```

Every file stays well under 400 lines and every function under 80 lines
(`createRedactor` in the pre-existing P0 `redact.ts` is the one 94-line
exception — flagged for a later split, out of the P1 scope).
