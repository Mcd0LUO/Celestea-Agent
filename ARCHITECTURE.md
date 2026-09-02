# celestea_harness — Architecture

An "everything is a plugin" AI agent harness in Rust, inspired by DeepSeek Harness.
No privileged core: the model adapter, session log, tool registry, agent loop, and
worker-orchestration seams are all swappable plugins that register into a shared
`Context`. The CLI composes concrete providers at startup and runs a chat REPL /
fullscreen TUI, a one-shot run, or a tool listing.

## Repo layout

A virtual workspace of **7 crates** (`members = ["crates/*"]`), each split from
the original single file into per-responsibility modules. The CLI is the only
binary (`celestea-cli`); the rest are libraries.

| Crate | Module files | Responsibility |
|---|---|---|
| `crates/core` | `lib.rs` + `context.rs`, `plugin.rs`, `registry.rs`, `event_bus.rs`, `message.rs`, `llm.rs`, `session_log.rs`, `tool.rs`, `agent.rs` | seam contracts (Context, Plugin, Registry, EventBus, Message, Llm, SessionLog, Tool, AgentLoop) |
| `crates/llm` | `lib.rs` + `config.rs`, `client.rs`, `registry.rs` | DeepSeek provider (async-openai, OpenAI-compatible) + multi-provider registry |
| `crates/tools` | `lib.rs` + `registry.rs`, `builtin.rs` | tool registry + guarded dispatch pipeline + builtin file/shell tools |
| `crates/session` | `lib.rs` + `log.rs`, `registry.rs`, `mailbox.rs` | append-only session log + multi-session registry + mailbox |
| `crates/agent-loop` | `lib.rs` + `events.rs`, `loop.rs` | default turn/step driver (cooperative cancellation + event sink) |
| `crates/workers` | `lib.rs` + `types.rs`, `registry.rs`, `tools.rs`, `plugin.rs`, `watchdog.rs` | worker orchestration: spawn / inter-session messaging / status + watchdog |
| `crates/cli` | `main.rs` + `config.rs`, `render.rs`, `redirect.rs`, `rich.rs`, `tui.rs`, `interrupt.rs`, `repl.rs` | entry point, compose, config loading, rich/TUI rendering, graceful interrupt, REPL |

Ownership within the workspace is by responsibility, not by numeric worker IDs:
the old `W101…W105` crate-ownership table is obsolete and each crate is now
internally consistent and self-owned. Root files (`Cargo.toml`, `README.md`,
`ARCHITECTURE.md`) are the architect's domain; code changes must not bleed
across crate boundaries.

## Core seams (crates/core/src/lib.rs)

`crates/core/src/lib.rs` is the pinned source of truth (each seam lives in its
own module and is re-exported from the crate root). Summary:

- `Context` — service container: `provide::<T>(svc)` / `get::<T>() -> Option<Arc<T>>`,
  plus `scoped()` for a per-agent child scope. Trait objects are wrapped in
  newtypes so they fit the `TypeId` map: `LlmService`, `LlmRegistryService`,
  `SessionService`, `ToolRegistryService`, `AgentLoopService`,
  `WorkerRegistryService`. Resolve with `ctx.get::<LlmService>()` etc.
- `Plugin` — `trait Plugin { fn mount(&mut Context) }`.
- `Registry` (`registry.rs`) — typed, named, replaceable rows (the patch
  primitive, e.g. `NamedRegistry<T>`).
- `EventBus` (`event_bus.rs`) — typed broadcast `on::<E>(f)` / `emit::<E>(e)`,
  observe-only, plus intercept/transform hooks.
- `Message` (`message.rs`) — the message / tool-call / tool-result data model
  crossing crates (`StreamEvent::Text` / `Done`, `ToolCall`, `ToolResult`, …).
- `Llm` (`llm.rs`) — `async fn generate(ModelRequest) -> Result<LlmStream, LlmError>`.
  A stream emits `StreamEvent::Text` deltas then a final `StreamEvent::Done(Message)`.
- `SessionLog` (`session_log.rs`) — append / events / derive_messages / clear.
  The log is the single source of truth; model history is derived from it.
- `Tool` / `ToolGuard` / `ToolRegistry` (`tool.rs`) — guarded dispatch
  (guards short-circuit with Deny/Ask; otherwise the tool executes).
- `AgentLoop` (`agent.rs`) — `async fn run_turn(ctx, user_input) -> Result<(), AgentError>`.

## Built-in capabilities

The tool face is built from **7 built-in tools**: the four file/shell tools plus
the three worker-orchestration tools, all registered through one
`register_all_tools` so `chat`, `run` and the `tools` subcommand can never drift
(`crates/cli/src/config.rs`):

| Tool | Owned by | Purpose |
|---|---|---|
| `read_file` / `write_file` / `list_dir` | `crates/tools/builtin.rs` | filesystem access |
| `run_shell` | `crates/tools/builtin.rs` | guarded shell command (`{stdout, stderr, exit_code}`) |
| `spawn_worker` | `crates/workers` | spawn a worker session in-process (create child session → name → drive via agent-loop → write registry.tsv) |
| `session_send_message` | `crates/workers` | inter-session message send (id / unique-name / candidate-list resolution) |
| `worker_status` | `crates/workers` | query registry.tsv → RUNNING / DONE / FAILED summary (optional wid filter) |

### Worker orchestration (crates/workers)

`crates/workers` implements the harness's in-process orchestration capability
(`types.rs` / `registry.rs` / `tools.rs` / `plugin.rs` / `watchdog.rs`):

- **Three tools** (`tools.rs`): `spawn_worker`, `session_send_message`,
  `worker_status`, packaged by `worker_tools_with(reg)` / `worker_tools()`.
- **`WorkerRegistry`** (`registry.rs`): `registry.tsv` read/write (atomic
  tmp+rename) plus the `SessionRegistry` / `SessionMailbox` references and the
  **driver seam** (`LlmService` / `ToolRegistryService` / `AgentLoopService`).
- **`WorkersPlugin`** / **`WatchdogPlugin`** (`plugin.rs`): `mount` calls
  `attach_drivers` so spawned workers can be **background-driven by the harness's
  own agent-loop (driven:true)**, then surfaces the shared `WorkerRegistry`
  as `WorkerRegistryService` in the Context and provides a composite tool registry.
- **`Watchdog`** (`watchdog.rs`): patrols `registry.tsv`, keeps RUNNING rows
  alive while a turn/mailbox is pending, marks DONE on deliverable
  (`results/<wid>-*.md`), and auto-re-dispatches failed rows (grace period →
  `max_retries(2)` → FAILED), logging to `watcher.log` / `alerts.log`.

The CLI wiring (`crates/cli/src/config.rs::compose`) constructs a shared
`Arc<WorkerRegistry>`, registers all 7 tools, then calls
`workers.attach_drivers(...)` **after** providing the driver seams so that
`spawn_worker` reports `driven: true` (full background-execution) rather than
just registering workers.

> Multi-agent orchestration was once a non-goal of the MVP; it is now a first-class
> in-process capability (harness spawns and drives workers itself — no shell-out
> to the external dsh runtime; dsh's spawn/session-bridge/watchdog are referenced
> only as state-machine and protocol models).

## Turn flow (what the loop must implement)

```text
turn/start -> append UserMessage -> loop up to max_steps:
  derive messages from session log
  build ModelRequest { model, system, messages, tools = registry.schemas(), .. }
  llm.generate(req) -> consume stream (print Text to stdout) -> collect Done(message)
  if message has tool calls:
    for each call: append ToolCall event, tools.dispatch(call) -> append ToolResult event
    continue
  else: append AssistantMessage, break
turn/end
```

Cooperative cancellation is supported via the agent-loop `cancel_set` /
`wait_cancel` plumbing (`crates/agent-loop/loop.rs`); the model, system prompt,
step budget and parallel-tool budget come from an `AgentConfig` composed from the
profile.

## CLI (crates/cli)

- **Command framework**: clap 4.6 (derive) — subcommands `chat` (default
  interactive), `run -e|--input [--json]` (one-shot), `tools` (list the full
  7-tool surface, no LLM/network needed). Global `--profile <path>` (TOML or
  legacy JSON auto-detected by extension) and `--strict`.
- **Async runtime**: tokio 1.53 (full).
- **REPL**: rustyline 18 — history / line editing / Tab **command completion**
  (`/tools /model /clear /profile /exit`), Ctrl-C (interrupt turn) / Ctrl-D
  (exit). On a non-TTY stdin it reads all input as one turn instead.
- **Fullscreen TUI**: ratatui 0.30 reusing the rich markdown renderer as ANSI
  spans for a chat-style interface; falls back to the streamed/REPL path on
  non-TTY or `--json`.
- **Rich rendering** (`rich.rs`): incremental markdown (pulldown-cmark),
  syntax highlighting (syntect, 24-bit true-color), faint `[thinking]` blocks
  and tool call/result cards.
- **TOML config** (`config.rs`): 9 keys (`model`, `system_prompt`, `max_steps`,
  `max_parallel_tool_calls`, `base_url`, `reasoning_effort`, `max_output_tokens`,
  `api_key_env`, `api_key_file`). Precedence: `celestea.toml` → legacy
  `profile.json` → defaults; plus a home-dir fallback `~/.celestea/celestea.toml`
  then `~/.celestea/profile.json`; `.env` is loaded (silently) from the current
  directory. API key never lands in a config file — only env / api_key_file.
- **Graceful interrupt** (`interrupt.rs`): Ctrl-C cancels the in-flight turn
  cooperatively and exits with code **130** (128+SIGINT).
- **Exit-code contract**: `0` success; `1` config/init error; `2` turn execution
  error; `3` runtime I/O/internal error; `130` interrupted. The REPL accumulates
  the most severe code seen.

## Build / verify

From the repo root:

```bash
cargo build --workspace        # whole workspace
cargo test --workspace         # 202-test surface; at this doc refresh 2 persistent-log recovery
                               # tests in celestea-session fail (see report)
cargo run -p celestea-cli -- tools
cargo run -p celestea-cli -- run -e "hello"
cargo build --release -p celestea-cli
```

## Release workflow

`.github/workflows/` builds and publishes prebuilt binaries:

- `ci.yml` — runs `cargo test --workspace` on every push / PR to GitHub.
- `release.yml` — on a `v*` tag push (or `workflow_dispatch` → run artifacts),
  cross-builds three targets and attaches them to a GitHub Release:
  - Linux `x86_64-unknown-linux-gnu` → `celestea-linux-x86_64.tar.gz` (ubuntu-22.04)
  - macOS `aarch64-apple-darwin` → `celestea-macos-aarch64.tar.gz` (macos-14, Apple Silicon)
  - Windows `x86_64-pc-windows-msvc` → `celestea-windows-x86_64.zip` (windows-2022, pwsh packaging)
  Upload uses the automatic `GITHUB_TOKEN` with the minimal `contents: write` scope;
  no secrets are hardcoded. `workflow_dispatch` builds artifacts but does not cut
  a Release (the binaries are grabable from the Actions page).

## Environment

- `DEEPSEEK_API_KEY` (required at runtime for the llm crate; configurable via
  `api_key_env`)
- `DEEPSEEK_BASE_URL` (optional, default `https://api.deepseek.com`; overridable
  via `base_url`)

