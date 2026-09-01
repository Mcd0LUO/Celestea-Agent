# celestea_harness — Architecture

An "everything is a plugin" AI agent harness in Rust, inspired by DeepSeek Harness.
No privileged core: the model adapter, session log, tool registry, and agent loop are
all swappable plugins that register into a shared Context.

## Repo layout and ownership

Each crate has exactly one owner (the architect or one worker). Owners may only write
inside their own crate directory. NEVER touch another crate or the root.

| Path | Owner | Role |
|---|---|---|
| Cargo.toml, .gitignore, README.md, ARCHITECTURE.md | architect | workspace + docs |
| crates/core | architect | seam contracts (Context, Plugin, EventBus, Llm, SessionLog, Tool, AgentLoop) |
| crates/llm | W101 | DeepSeek provider (async-openai, OpenAI-compatible) |
| crates/session | W102 | append-only session log + derive_messages |
| crates/tools | W103 | tool registry + guarded pipeline + builtin tools |
| crates/agent-loop | W104 | default turn/step driver |
| crates/cli | W105 | entry point, compose, profile loading, REPL |

## Core seams (crates/core/src/lib.rs)

Read crates/core/src/lib.rs first; it is the source of truth. Summary:

- Context: provide::<T>(svc) / get::<T>() -> Option<Arc<T>>, plus scoped() for a
  per-agent child scope. Trait objects are wrapped in newtypes so they fit the TypeId
  map: LlmService, SessionService, ToolRegistryService, AgentLoopService. Resolve with
  ctx.get::<LlmService>() etc.
- Plugin: trait Plugin { fn mount(&mut Context) }.
- EventBus: typed broadcast. on::<E>(f) / emit::<E>(e). Observe-only.
- NamedRegistry<T>: named replaceable rows (the patch primitive).
- Llm: async fn generate(ModelRequest) -> Result<LlmStream, LlmError>. A stream emits
  StreamEvent::Text deltas then a final StreamEvent::Done(Message).
- SessionLog: append / events / derive_messages / clear. The log is the single source
  of truth; model history is derived from it.
- Tool / ToolGuard / ToolRegistry: guarded dispatch (guards short-circuit with Deny/Ask;
  otherwise the tool executes).
- AgentLoop: async fn run_turn(ctx, user_input) -> Result<(), AgentError>.

## Pinned public API (workers implement exactly these)

llm (W101):
  pub struct DeepSeekLlm { ... }
  impl DeepSeekLlm {
    pub fn from_env() -> Result<Self, celestea_core::LlmError>; // DEEPSEEK_API_KEY, optional DEEPSEEK_BASE_URL (default https://api.deepseek.com)
    pub fn with_model(self, model: impl Into<String>) -> Self;
  }
  impl celestea_core::Llm for DeepSeekLlm { async fn generate(...) }

session (W102):
  pub struct InMemorySessionLog { ... } // Send + Sync via interior mutability
  impl InMemorySessionLog { pub fn new() -> Self }
  impl celestea_core::SessionLog for InMemorySessionLog { ... }

tools (W103):
  pub struct ToolRegistryImpl { ... }
  impl ToolRegistryImpl { pub fn new() -> Self }
  impl celestea_core::ToolRegistry for ToolRegistryImpl { ... }
  pub fn builtin_tools() -> Vec<Box<dyn celestea_core::Tool>>; // read_file, write_file, list_dir, run_shell

agent-loop (W104):
  pub struct DefaultAgentLoop { ... }
  impl DefaultAgentLoop { pub fn new(config: celestea_core::AgentConfig) -> Self }
  impl celestea_core::AgentLoop for DefaultAgentLoop { async fn run_turn(...) }

cli (W105):
  main.rs: parse --profile (JSON), build Context, mount the plugins above, provide
  the *Service newtypes, then run a stdin REPL that calls run_turn.

## Turn flow (what the loop must implement)

  turn/start -> append UserMessage -> loop up to max_steps:
    derive messages from session log
    build ModelRequest { model, system, messages, tools = registry.schemas(), .. }
    llm.generate(req) -> consume stream (print Text to stdout) -> collect Done(message)
    if message has tool calls:
      for each call: append ToolCall event, tools.dispatch(call) -> append ToolResult event
      continue
    else: append AssistantMessage, break
  turn/end

## Concurrency rules

- You own exactly one crate directory. Do not edit root Cargo.toml, ARCHITECTURE.md,
  docs/, or any other crates/* directory.
- Do not run cargo add / cargo remove (deps are pinned). If you truly need another
  dependency, note it in your REPORT.md instead of editing Cargo.toml.
- Verify with: cargo build -p <your-crate>  (from the repo root).
- If cargo reports "Blocking waiting for file lock", just retry after a few seconds.
- Do not git commit. Just write code and your REPORT.md.

## Build / verify

  cargo build
  cargo build -p celestea-llm
  cargo build -p celestea-session
  cargo build -p celestea-tools
  cargo build -p celestea-agent-loop
  cargo run -p celestea-cli -- --profile profile.json

## Non-goals for MVP

No OS sandboxing, no persistence (in-memory session), no dynamic plugin loading, no
multi-agent orchestration. These are later phases; keep the seams ready for them.

## Environment

- DEEPSEEK_API_KEY (required at runtime for the llm crate)
- DEEPSEEK_BASE_URL (optional, default https://api.deepseek.com)
