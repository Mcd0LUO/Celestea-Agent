# @celestea/session

The session log: in-memory and JSONL-backed `SessionLog` implementations, the
replay/repair path, the monotonic turn-id owner, and the two message
projections (Studio + engine). Depends only on `@celestea/core`.

Ports (1:1 against the Rust engine):

| TS module | Rust source |
|---|---|
| `log/derive.ts` | `crates/session/src/log.rs` (`derive_messages_from`, `flush_tool_calls`, `balance_tool_calls`, `project`) |
| `log/memory.ts` | `crates/session/src/log.rs` (`InMemorySessionLog`) |
| `log/file.ts` | `crates/session/src/persistent.rs` (naming, replay, torn-tail truncation) |
| `log/persistent.ts` | `crates/session/src/persistent.rs` (`PersistentSessionLog`) |
| `turn-id.ts` | `session_log.rs:94-98` + `persistent.rs:382-402` (turn id ownership) |
| `messages.ts` | `crates/session/src/log.rs` + Studio `src/api.rs:94-135` |
| `replay.ts` | P0 replay analysis + SSE transcript derivation |

## Public API (via `index.ts` only)

- **Logs** — `InMemorySessionLog`, `PersistentSessionLog.open(dir, sessionId,
  opts?)`, `defaultPersistentOptions()`, `PersistentOptions`.
- **Plugins** — `inMemorySessionLogPlugin()`, `persistentSessionLogPlugin(cfg)`;
  both provide the log under core's `SESSION_LOG_SERVICE` token. Core never
  imports this package: register the plugin into a `Context` at compose time.
- **Projections** — `projectMessages` (Studio: per-event, keeps thinking rows,
  keeps `parent_id` rows) and `deriveMessages` (engine: model-visible history —
  drops turn markers, thinking and `parent_id` sub-calls, merges consecutive
  tool calls into one assistant message, balances unanswered calls with a
  synthetic cancelled result).
- **JSONL** — `parseSessionJsonl`, `serializeSessionJsonl`, plus re-exports of
  the serde-exact row codec (`validateSessionEvent`, `parseSessionEvent`,
  `serializeSessionEvent`, `outcomePhase`, `outcomeError`) from core.
- **Files** — `fileNameFor`, `filePathFor`, `replayFile` (longest valid prefix +
  torn record), `nextTurnId`, `nextTurnNumber`, `auditTurnIds`.
- **Analysis** — `analyzeReplay`, `deriveSseTranscript` (P0 replay toolchain).

## Extension points

```ts
import { Context, mountPlugins, SESSION_LOG_SERVICE, type SessionLog } from "@celestea/core";
import { persistentSessionLogPlugin } from "@celestea/session";

const ctx = mountPlugins(Context.root(), [
  persistentSessionLogPlugin({ dir: "~/.celestea/sessions", sessionId: "session-1" }),
]);
const log = ctx.require<SessionLog>(SESSION_LOG_SERVICE);
log.append({ type: "user_message", text: "hi" });
log.nextTurnId();      // "turn-0" — owned by the log, monotonic, restored on open
log.deriveMessages();  // Rust Message[] (role / content[] / tool_call_id)
```

Swap in `inMemorySessionLogPlugin()` for tests; a later mount of the same token
wins (patch semantics), so composition never needs editing.

## Durability semantics

- One record == one JSON line; `append` writes through to the OS immediately
  (`fs.writeSync`), so `flushEachAppend:false` cannot lose a record (documented
  deviation from Rust's `BufWriter`, in the safe direction); `sync()` is the
  fsync/power-loss durability point and `syncEachAppend` fsyncs every record.
- On open the file is replayed and validated: the **longest valid prefix** is
  kept and everything from the first unparsable record (a torn tail) is
  truncated away; blank lines are harmless padding; a missing final newline is
  repaired before the next append.
- The turn counter is restored from the max `turn-<n>` id on disk (+1), so ids
  are never reused after a restart. `clear()` truncates the file and resets the
  counter (Rust behaviour); the in-memory log's counter deliberately never
  resets.
- A failed disk write degrades gracefully: the event stays in the in-memory
  view (`deriveMessages` keeps working) and `writeErrorCount()` counts it.

## derive_messages contract (engine parity)

`derive_messages_from` walks the log and: skips `TurnStart`/`TurnEnd`; skips
`ThinkingDelta`; accumulates `ToolCall` rows (skipping `parent_id` sub-calls)
and flushes them into ONE assistant message before any other event and at the
end; projects `ToolResult` as `Error: {err}` (non-empty error) or the
serde_json text of the value; then `balance_tool_calls` inserts
`Error: tool call was cancelled before execution (no result recorded)` for every
unanswered call (engine commit b046564 / W267).

**Ported upstream quirks** (parity over silent divergence, reported upstream):

1. `balance_tool_calls` advances its cursor with `i = j + inserted + 1`, so the
   message right after a fully-answered call's results is never balance-checked;
   an unbalanced trailing call in exactly that position stays unbalanced.
   Covered by `log/derive.test.ts` and reproduced against the real engine.
2. A whitespace-only JSONL line is an unparsable record (Rust `record.is_empty()`),
   not padding.

## Golden fixtures & the Rust parity test

`fixtures/sessions/*/derive-messages-expected.json` is a **Rust golden**: since
the engine exposes `derive_messages` over no HTTP surface, it is generated by
the read-only probe in `tools/rust-parity-probe/` (links `celestea-core` +
`celestea-session`). `src/parity.test.ts` asserts, per session and field for
field: `deriveMessages` vs that golden, `projectMessages` vs the Rust HTTP
golden, and a byte-identical JSONL round-trip of every event line.

```sh
pnpm vitest run packages/session/src/parity.test.ts    # Rust parity suite
```

## File layout

```
src/log/derive.test.ts    184  derive_messages parity suite (Rust tests ported)
src/replay.ts             160  replay analysis + SSE transcript (P0)
src/log/derive.ts         147  derive_messages + balance_tool_calls
src/log/persistent.ts     143  PersistentSessionLog (JSONL, replay, restore)
src/log/file.ts           106  file naming + replay/truncate helpers
src/jsonl.test.ts          99  file-level JSONL contract
src/parity.test.ts         89  Rust golden parity (parity.test.ts)
src/turn-id.ts             83  turn id math + audit
src/jsonl.ts               80  file-level parse/serialize + codec re-exports
src/messages.ts            74  Studio projection + deriveMessages facade
src/log/persistent.test.ts 174 torn tail / blank lines / counter restore
src/log/memory.ts          55  InMemorySessionLog
src/plugin.ts              40  Context registration
src/index.ts               33  the only public entry point
tools/rust-parity-probe/       read-only Rust probe that generates the goldens
```
