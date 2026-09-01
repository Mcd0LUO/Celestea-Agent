# celestea-cli (W105) — REPORT

## Scope

Implemented the CLI integration entry point in `crates/cli/src/main.rs` and added
`crates/cli/profile.example.json`. No changes were made outside `crates/cli/`
(root Cargo.toml, ARCHITECTURE.md, crates/core, and sibling crates were left
untouched). No `cargo add`/`cargo remove` was run and no git commit was made.

## Implementation notes

- `#[tokio::main]` entry calls `tracing_subscriber::fmt().init()` first.
- `clap` (derive) parses `--profile <path>` (default `profile.json`).
- `load_profile` reads the JSON profile and merges the four documented keys
  (`model`, `system_prompt`, `max_steps`, `max_parallel_tool_calls`) over
  defaults (`deepseek-chat` / `"You are a helpful assistant."` / 16 / 4).
  A missing file falls back to defaults (with a stderr note); a present-but-invalid
  or unreadable file is a hard error. Parsing uses `serde_json::Value` so no
  `serde` derive dependency was needed (only `serde_json`, already declared).
- Composition (exactly per the pinned API):
  - `DeepSeekLlm::from_env()` → `.with_model(model)` → `Arc<dyn Llm>`
    wrapped in `LlmService`.
  - `InMemorySessionLog::new()` → `Arc<dyn SessionLog>` → `SessionService`.
  - `ToolRegistryImpl::new()` + every `builtin_tools()` registered →
    `Arc<dyn ToolRegistry>` → `ToolRegistryService`.
  - `DefaultAgentLoop::new(AgentConfig { model, system_prompt, max_steps,
    max_parallel_tool_calls })` → `Arc<dyn AgentLoop>` → `AgentLoopService`.
  - All four provided into a single `Context`.
- REPL: reads stdin line-by-line with `tokio::io::AsyncBufReadExt` +
  `BufReader::lines()`; blank lines are skipped, `exit`/`quit` (and EOF)
  terminate; otherwise `agent.run_turn(&ctx, line)` is awaited and any
  `AgentError` is printed to stderr.

## Build / verify

`cargo build -p celestea-cli` — **passes** (exit 0, no warnings):

    Compiling celestea-cli v0.1.0
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.84s

`celestea --help` renders the expected usage (name, `--profile`, defaults).

Runtime requires `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`); this is
checked inside `DeepSeekLlm::from_env` and surfaces as a clear anyhow error
before the REPL starts. Compilation has no API-key dependency.

## Known issues / remaining work

- None blocking. The only runtime dependency is `DEEPSEEK_API_KEY`; the CLI
  deliberately does not validate its presence until the REPL is about to start.
- `profile.example.json` records the default values; users copy it to
  `profile.json` to override.
- `max_parallel_tool_calls` is threaded into `AgentConfig` but the current
  `DefaultAgentLoop` dispatches tool calls sequentially (it drives one turn
  step at a time); parallel dispatch is a future agent-loop enhancement, not a
  CLI concern.
