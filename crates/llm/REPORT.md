# celestea-llm (W101) — Implementation report

## Files created / modified

- `crates/llm/src/lib.rs` — `DeepSeekLlm` implementation (rewritten from the stub).
- `crates/llm/Cargo.toml` — enabled the `chat-completion` feature on the pinned `async-openai` dependency (see note below).

## Pinned API implemented

- `pub struct DeepSeekLlm { client: Client<OpenAIConfig>, model: String }`
- `impl DeepSeekLlm`
  - `pub fn from_env() -> Result<Self, celestea_core::LlmError>`
  - `pub fn with_model(self, model: impl Into<String>) -> Self`
- `impl celestea_core::Llm for DeepSeekLlm`
  - `async fn generate(&self, req: ModelRequest) -> Result<LlmStream, LlmError>`

`from_env` reads `DEEPSEEK_API_KEY` (returns `Err(LlmError)` when missing) and
optional `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`), then builds
`OpenAIConfig::new().with_api_base(base).with_api_key(key)` and
`Client::with_config(config)`. Default model is `deepseek-chat`.

## Key implementation points

- **Message mapping** (`map_message`): core `Message` -> `ChatCompletionRequestMessage`.
  - `Role::System` / `Role::User` -> `System` / `User` with `*MessageContent::Text`.
  - `Role::Assistant` -> `Assistant` with `content` (text) plus `tool_calls` built from
    `Content::ToolCall`; `FunctionCall.arguments` is the JSON string of `ToolCall.args`.
  - `Role::Tool` -> `Tool` with `tool_call_id` from `Message.tool_call_id`.
  - Multiple `Content::Text` parts are joined with a newline.
- **Tool mapping** (`map_tool`): `ToolSpec` -> `ChatCompletionTools::Function(ChatCompletionTool {
  function: FunctionObject { name, description, parameters, strict: None } })`.
  Note: async-openai 0.41's `FunctionObject.parameters` is plain
  `Option<serde_json::Value>` (the task mentioned a `FunctionParameters` newtype, which does
  not exist in 0.41.3 — verified against the vendored source), so the value is passed directly.
- **Request building** (`build_request`): `CreateChatCompletionRequest` with `stream: Some(true)`,
  `max_tokens` (DeepSeek accepts `max_tokens`, not the OpenAI o-series `max_completion_tokens`;
  the deprecated field is used under `#[allow(deprecated)]`), `temperature`, and the system
  message prepended when `req.system` is `Some`. Model precedence: `req.model` wins when non-empty,
  otherwise `with_model`'s value is used.
- **Stream construction** (`generate`): `client.chat().create_stream(request)` then an
  `async_stream::stream!` block that:
  - yields `StreamEvent::Text(delta.content)` for each non-empty content delta, accumulating the
    full text;
  - accumulates tool-call deltas per `index` (`id` / `name` / `arguments` fragments) in a
    `BTreeMap<u32, ToolCallAcc>` so parallel tool calls stay ordered;
  - ignores `delta.role`, `delta.refusal` and any reasoning/thinking fields;
  - ends with `StreamEvent::Done(Message)` carrying the assistant text plus reconstructed
    `ToolCall { id, name, args }` (`args` parsed via `serde_json`).
- Mid-stream `Err` chunks terminate the stream and still emit `Done` (the stream item type cannot
  carry an error, so a network failure surfaces as a truncated turn).
- `parse_arguments` falls back to `Value::String(raw)` on malformed JSON so nothing is silently lost.

## Verification

- `cargo build -p celestea-llm` — **passes** (no warnings).
- `cargo test -p celestea-llm` — **6/6 pass** (message/tool mapping and wire-format checks; no network).

## Dependency note (feature flag)

async-openai 0.41's default features are only `["rustls"]`; the chat-completion types and the
`Client`/`create_stream` API are gated behind the `chat-completion` feature (which transitively
enables `_api` + `chat-completion-types`). I therefore changed the llm crate's own `Cargo.toml` from
`async-openai.workspace = true` to `async-openai = { workspace = true, features = ["chat-completion"] }`.
This does not add/remove any dependency and leaves the pinned version untouched; it only enables an
existing feature. If the architect prefers this at the workspace level instead, it can be moved to the
root `[workspace.dependencies]` entry.

## Assumptions / open items

- Default model is `deepseek-chat` (matches `AgentConfig::default()`); `with_model` only acts as a
  fallback when `req.model` is empty.
- `max_tokens` (not `max_completion_tokens`) is sent to match DeepSeek's API; `max_tokens` is marked
  deprecated in async-openai 0.41 and is used under `#[allow(deprecated)]`.
- Mid-stream chunk errors are not surfaced (stream items can't carry errors); the final `Done` is still
  emitted with whatever was accumulated.
- `DEEPSEEK_BASE_URL` is used verbatim as the API base (no `/v1` appended); DeepSeek serves both forms.
