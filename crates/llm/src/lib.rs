//! celestea-llm — DeepSeek provider (W101).
//!
//! Implements the celestea_core::Llm seam on top of async-openai 0.41, which
//! speaks the OpenAI-compatible HTTP API that DeepSeek exposes. Streaming is
//! handled by async-openai's SSE parser; this crate translates the core seam
//! types (Message, ToolSpec, ModelRequest) into a chat-completions request and
//! maps the streamed chunks back into StreamEvent::Text deltas plus a single
//! final StreamEvent::Done message.
//!
//! The model-adapter types live here, not in `celestea-core`: the adapter is a
//! replaceable plugin, so its configuration and capability catalog are plugin
//! concerns. The provider is configured with [`DeepSeekConfig`] (either built
//! directly and passed to [`DeepSeekLlm::new`], or assembled from the
//! environment by [`DeepSeekLlm::from_env`]). The model catalog is not
//! hardcoded here: the provider talks to whatever OpenAI-compatible endpoint
//! `base_url` points at, which decides its own catalog. `generate` only
//! requires a non-empty model name.

//! [`LlmError`] that lists the supported ones.
//!
//! Reasoning: `reasoning_effort` from the config is mapped onto the request.
//! DeepSeek accepts `max_tokens` (not OpenAI's `max_completion_tokens`); for
//! `deepseek-reasoner` the field caps the final answer — the CoT
//! (`reasoning_content`) runs on top and is not counted against the context.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use async_openai::config::OpenAIConfig;
use async_openai::types::chat::{
    ChatCompletionMessageToolCall, ChatCompletionMessageToolCalls,
    ChatCompletionRequestAssistantMessage, ChatCompletionRequestAssistantMessageContent,
    ChatCompletionRequestMessage, ChatCompletionRequestSystemMessage,
    ChatCompletionRequestSystemMessageContent, ChatCompletionRequestToolMessage,
    ChatCompletionRequestToolMessageContent, ChatCompletionRequestUserMessage,
    ChatCompletionRequestUserMessageContent, ChatCompletionTool, ChatCompletionTools,
    CreateChatCompletionRequest, FunctionCall, FunctionObject,
};
use async_openai::Client;
use async_stream::stream;
use async_trait::async_trait;
use celestea_core::{
    Content, Llm, LlmError, LlmRegistry, LlmStream, Message, ModelRequest, Role, StreamEvent,
    ToolCall, ToolSpec,
};
use futures_util::StreamExt;

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-chat";
const API_KEY_ENV: &str = "DEEPSEEK_API_KEY";
const BASE_URL_ENV: &str = "DEEPSEEK_BASE_URL";

/// Reasoning effort for reasoning models (`deepseek-reasoner`).
///
/// Mirrors the subset of the OpenAI/DeepSeek `reasoning_effort` parameter that
/// this provider exposes. Only `low` / `medium` / `high` are surfaced;
/// `minimal` and the future `xhigh` are deliberately not exposed yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
}

impl From<ReasoningEffort> for async_openai::types::chat::ReasoningEffort {
    fn from(effort: ReasoningEffort) -> Self {
        match effort {
            ReasoningEffort::Low => Self::Low,
            ReasoningEffort::Medium => Self::Medium,
            ReasoningEffort::High => Self::High,
        }
    }
}

/// Static capability metadata for a model this provider supports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub name: String,
    /// Maximum input+output tokens the model accepts (context window).
    pub context_length: usize,
    /// Maximum output tokens the model can generate.
    pub max_output_tokens: usize,
    /// Whether the model produces a CoT (`reasoning_content`) before answering.
    pub supports_reasoning: bool,
}

/// Provider configuration for the DeepSeek adapter.
///
/// This is a plugin-level concern: the core `Llm` seam is not aware of it.
/// The API key is consumed when the client is built and is not exposed through
/// `Debug` (`api_key` has no `Debug` printing of its value here by design —
/// it lives in the config struct only during construction).
#[derive(Clone)]
pub struct DeepSeekConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub max_output_tokens: Option<u32>,
}

impl std::fmt::Debug for DeepSeekConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeepSeekConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .field("model", &self.model)
            .field("reasoning_effort", &self.reasoning_effort)
            .field("max_output_tokens", &self.max_output_tokens)
            .finish()
    }
}

/// DeepSeek provider backed by async-openai (OpenAI-compatible).
///
/// Created with [`DeepSeekLlm::new`] from a [`DeepSeekConfig`], or with the
/// [`DeepSeekLlm::from_env`] convenience path. `with_model` remains as a
/// back-compat setter for the fallback model. The model passed to a given
/// `ModelRequest` takes precedence; the configured model is used when the
/// request leaves its model empty. `generate` requires only a non-empty
/// model name (no hardcoded catalog; the endpoint decides the models).

pub struct DeepSeekLlm {
    client: Client<OpenAIConfig>,
    model: String,
    reasoning_effort: Option<ReasoningEffort>,
    max_output_tokens: Option<u32>,
}

impl DeepSeekLlm {
    /// Build a provider from an explicit config.
    ///
    /// The constructor is infallible per the pinned API (`-> Self`), so model
    /// validation that must surface an `Err` happens on the request path in
    /// [`DeepSeekLlm::generate`] (and in the `Result`-returning `from_env`);
    /// callers may pre-check with [`DeepSeekLlm::validate_model`].
    pub fn new(config: DeepSeekConfig) -> Self {
        let openai_config = OpenAIConfig::new()
            .with_api_base(config.base_url)
            .with_api_key(config.api_key);
        let client = Client::with_config(openai_config);
        Self {
            client,
            model: config.model,
            reasoning_effort: config.reasoning_effort,
            max_output_tokens: config.max_output_tokens,
        }
    }

    /// Build a client from the environment.
    ///
    /// DEEPSEEK_API_KEY — required; returns LlmError when unset.
    /// DEEPSEEK_BASE_URL — optional; defaults to https://api.deepseek.com.
    /// Model defaults to `deepseek-chat` and is validated against the catalog.
    pub fn from_env() -> Result<Self, LlmError> {
        let api_key = std::env::var(API_KEY_ENV)
            .map_err(|_| LlmError(format!("{API_KEY_ENV} is not set")))?;
        let api_base = std::env::var(BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());

        let config = DeepSeekConfig {
            base_url: api_base,
            api_key,
            model: DEFAULT_MODEL.to_string(),
            reasoning_effort: None,
            max_output_tokens: None,
        };
        let llm = Self::new(config);
        llm.validate_model(&llm.model)?;
        Ok(llm)
    }

    /// Set the model used when a ModelRequest does not specify one (back-compat).
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    /// Validate the model string. Model names are free-form: the provider
    /// talks to whatever OpenAI-compatible endpoint `base_url` points at,
    /// and that endpoint decides its own model catalog (e.g. a local shim
    /// exposing `deepseek-v4-flash`), so there is no hardcoded preset list.
    /// The only hard rule is that a model must be supplied.
    pub fn validate_model(&self, model: &str) -> Result<(), LlmError> {
        if model.trim().is_empty() {
            Err(LlmError("model must not be empty".into()))
        } else {
            Ok(())
        }
    }

    fn effective_model(&self, req: &ModelRequest) -> String {
        if req.model.is_empty() {
            self.model.clone()
        } else {
            req.model.clone()
        }
    }

    #[allow(deprecated)] // DeepSeek accepts max_tokens (not max_completion_tokens)
    fn build_request(&self, req: &ModelRequest) -> CreateChatCompletionRequest {
        let mut messages = Vec::with_capacity(req.messages.len() + 1);
        if let Some(system) = &req.system {
            messages.push(ChatCompletionRequestMessage::System(
                ChatCompletionRequestSystemMessage {
                    content: ChatCompletionRequestSystemMessageContent::Text(system.clone()),
                    name: None,
                },
            ));
        }
        messages.extend(req.messages.iter().map(map_message));

        let tools: Vec<ChatCompletionTools> = req.tools.iter().map(map_tool).collect();

        // Output cap: the request's explicit max_tokens wins; otherwise fall
        // back to the config's max_output_tokens (both Option<u32>).
        let max_tokens = req.max_tokens.or(self.max_output_tokens);

        CreateChatCompletionRequest {
            model: self.effective_model(req),
            messages,
            tools: if tools.is_empty() { None } else { Some(tools) },
            reasoning_effort: self.reasoning_effort.map(Into::into),
            max_tokens,
            temperature: req.temperature,
            stream: Some(true),
            ..Default::default()
        }
    }
}

#[async_trait]
impl Llm for DeepSeekLlm {
    async fn generate(&self, req: ModelRequest) -> Result<LlmStream, LlmError> {
        let model = self.effective_model(&req);
        self.validate_model(&model)?;

        let request = self.build_request(&req);
        let mut upstream = self
            .client
            .chat()
            .create_stream(request)
            .await
            .map_err(|e| LlmError(format!("failed to start stream: {e}")))?;

        let s = stream! {
            let mut text = String::new();
            // Tool-call deltas arrive in fragments keyed by index; accumulate
            // id / name / arguments per index and reconstruct in order.
            let mut acc: BTreeMap<u32, ToolCallAcc> = BTreeMap::new();

            while let Some(chunk) = upstream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    // Network/parse error mid-stream: stop and emit the final
                    // Done with whatever we accumulated. The stream item type
                    // cannot carry an error, so it surfaces as a truncated turn.
                    Err(_) => break,
                };

                for choice in chunk.choices {
                    let delta = choice.delta;

                    if let Some(content) = delta.content {
                        if !content.is_empty() {
                            text.push_str(&content);
                            yield StreamEvent::Text(content);
                        }
                    }

                    if let Some(tool_calls) = delta.tool_calls {
                        for tc in tool_calls {
                            let entry = acc.entry(tc.index).or_default();
                            if let Some(id) = tc.id {
                                entry.id = id;
                            }
                            if let Some(function) = tc.function {
                                if let Some(name) = function.name {
                                    entry.name.push_str(&name);
                                }
                                if let Some(arguments) = function.arguments {
                                    entry.arguments.push_str(&arguments);
                                }
                            }
                        }
                    }

                    // delta.role, delta.refusal and the CoT (reasoning_content)
                    // are intentionally not surfaced as StreamEvents.
                }
            }

            let mut content = Vec::new();
            if !text.is_empty() {
                content.push(Content::Text(text));
            }
            for acc in acc.into_values() {
                content.push(Content::ToolCall(ToolCall {
                    id: acc.id,
                    name: acc.name,
                    args: parse_arguments(&acc.arguments),
                }));
            }

            yield StreamEvent::Done(Message {
                role: Role::Assistant,
                content,
                tool_call_id: None,
            });
        };

        Ok(Box::pin(s))
    }
}

/// Convenience: a default LlmRegistry with the DeepSeek provider registered
/// under the canonical name "deepseek" (W189). Compose code can register further
/// providers on top; a later registration of the same name shadows the earlier
/// one, per the patch semantics.
pub fn deepseek_registry(llm: DeepSeekLlm) -> LlmRegistry {
    let mut reg = LlmRegistry::default();
    reg.register("deepseek", Arc::new(llm));
    reg
}

/// Per-index accumulator for a streamed tool call.
#[derive(Default)]
struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

/// Map a core Message to an OpenAI-compatible chat request message.
fn map_message(msg: &Message) -> ChatCompletionRequestMessage {
    match msg.role {
        Role::System => ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(collect_text(&msg.content)),
            name: None,
        }),
        Role::User => ChatCompletionRequestMessage::User(ChatCompletionRequestUserMessage {
            content: ChatCompletionRequestUserMessageContent::Text(collect_text(&msg.content)),
            name: None,
        }),
        Role::Assistant => {
            let text = collect_text(&msg.content);
            let tool_calls: Vec<ChatCompletionMessageToolCalls> = msg
                .content
                .iter()
                .filter_map(|c| match c {
                    Content::ToolCall(tc) => Some(ChatCompletionMessageToolCalls::Function(
                        ChatCompletionMessageToolCall {
                            id: tc.id.clone(),
                            function: FunctionCall {
                                name: tc.name.clone(),
                                arguments: tc.args.to_string(),
                            },
                        },
                    )),
                    _ => None,
                })
                .collect();

            ChatCompletionRequestMessage::Assistant(ChatCompletionRequestAssistantMessage {
                content: if text.is_empty() {
                    None
                } else {
                    Some(ChatCompletionRequestAssistantMessageContent::Text(text))
                },
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
                ..Default::default()
            })
        }
        Role::Tool => ChatCompletionRequestMessage::Tool(ChatCompletionRequestToolMessage {
            content: ChatCompletionRequestToolMessageContent::Text(collect_text(&msg.content)),
            tool_call_id: msg.tool_call_id.clone().unwrap_or_default(),
        }),
    }
}

/// Map a core ToolSpec to an OpenAI-compatible function tool.
fn map_tool(spec: &ToolSpec) -> ChatCompletionTools {
    ChatCompletionTools::Function(ChatCompletionTool {
        function: FunctionObject {
            name: spec.name.clone(),
            description: Some(spec.description.clone()),
            parameters: Some(spec.parameters.clone()),
            strict: None,
        },
    })
}

/// Concatenate the text segments of a message's content parts.
fn collect_text(content: &[Content]) -> String {
    let parts: Vec<&str> = content
        .iter()
        .filter_map(|c| match c {
            Content::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    parts.join("\n")
}

/// Parse accumulated tool-call arguments. On malformed JSON, preserve the raw
/// string rather than dropping it so downstream callers can inspect what the
/// model produced.
fn parse_arguments(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use celestea_core::Message;

    fn test_llm() -> DeepSeekLlm {
        DeepSeekLlm::new(DeepSeekConfig {
            base_url: "https://api.deepseek.com".into(),
            api_key: "sk-test".into(),
            model: "deepseek-chat".into(),
            reasoning_effort: None,
            max_output_tokens: None,
        })
    }

    #[test]
    fn reasoning_effort_serde_and_mapping() {
        assert_eq!(
            serde_json::to_string(&ReasoningEffort::Low).unwrap(),
            "\"low\""
        );
        assert_eq!(
            serde_json::to_string(&ReasoningEffort::Medium).unwrap(),
            "\"medium\""
        );
        assert_eq!(
            serde_json::to_string(&ReasoningEffort::High).unwrap(),
            "\"high\""
        );
        use async_openai::types::chat::ReasoningEffort as OaEffort;
        assert_eq!(OaEffort::from(ReasoningEffort::Low), OaEffort::Low);
        assert_eq!(OaEffort::from(ReasoningEffort::Medium), OaEffort::Medium);
        assert_eq!(OaEffort::from(ReasoningEffort::High), OaEffort::High);
    }

    #[test]
    fn config_construction_roundtrip() {
        let llm = DeepSeekLlm::new(DeepSeekConfig {
            base_url: "https://example.test".into(),
            api_key: "sk-secret".into(),
            model: "deepseek-reasoner".into(),
            reasoning_effort: Some(ReasoningEffort::High),
            max_output_tokens: Some(4096),
        });
        assert_eq!(llm.model, "deepseek-reasoner");
        assert_eq!(llm.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(llm.max_output_tokens, Some(4096));
    }

    #[test]
    fn build_request_maps_reasoning_effort_and_max_tokens() {
        let llm = DeepSeekLlm::new(DeepSeekConfig {
            base_url: "https://api.deepseek.com".into(),
            api_key: "sk-test".into(),
            model: "deepseek-reasoner".into(),
            reasoning_effort: Some(ReasoningEffort::High),
            max_output_tokens: Some(2048),
        });
        let req = ModelRequest {
            model: "deepseek-reasoner".into(),
            system: None,
            messages: vec![Message::user("hi")],
            tools: vec![],
            max_tokens: None,
            temperature: Some(0.6),
        };
        let json = serde_json::to_value(&llm.build_request(&req)).unwrap();
        assert_eq!(json["reasoning_effort"], "high");
        // config max_output_tokens is the fallback when the request is silent
        assert_eq!(json["max_tokens"], 2048);
        let temp = json["temperature"].as_f64().unwrap();
        assert!((temp - 0.6).abs() < 1e-6, "temperature={temp}");
    }

    #[test]
    fn build_request_request_max_tokens_wins_over_config() {
        let llm = DeepSeekLlm::new(DeepSeekConfig {
            base_url: "https://api.deepseek.com".into(),
            api_key: "sk-test".into(),
            model: "deepseek-chat".into(),
            reasoning_effort: None,
            max_output_tokens: Some(2048),
        });
        let req = ModelRequest {
            model: String::new(),
            system: None,
            messages: vec![Message::user("hi")],
            tools: vec![],
            max_tokens: Some(128),
            temperature: None,
        };
        let json = serde_json::to_value(&llm.build_request(&req)).unwrap();
        assert_eq!(json["max_tokens"], 128);
    }

    #[test]
    fn validate_model_requires_non_empty_model() {
        let llm = test_llm();
        // Free-form model names are accepted (no hardcoded catalog):
        assert!(llm.validate_model("deepseek-chat").is_ok());
        assert!(llm.validate_model("deepseek-v4-flash").is_ok());
        assert!(llm.validate_model("glm-5.2").is_ok());
        assert!(llm.validate_model("  ").is_err());
        assert!(llm.validate_model("").is_err());
    }

    // ---- W189: LLM adapter registry (multi-provider seam) --------------------

    #[test]
    fn deepseek_registry_registers_deepseek() {
        let reg = deepseek_registry(test_llm());
        // the default registry exposes exactly one provider under "deepseek"
        assert_eq!(reg.list(), vec!["deepseek".to_string()]);
        assert!(reg.resolve("deepseek").is_some());
        assert!(reg.resolve("openai").is_none());
        // registered adapters are shareable Arcs usable as Arc<dyn Llm>
        let _llm: Arc<dyn Llm> = reg.resolve("deepseek").unwrap();
    }

    #[test]
    fn maps_user_message() {
        let msg = Message::user("hello");
        match map_message(&msg) {
            ChatCompletionRequestMessage::User(m) => {
                assert_eq!(
                    m.content,
                    ChatCompletionRequestUserMessageContent::Text("hello".into())
                );
            }
            other => panic!("expected User message, got {other:?}"),
        }
    }

    #[test]
    fn maps_tool_result_with_call_id() {
        let msg = Message::tool_result("call_123", "result text");
        match map_message(&msg) {
            ChatCompletionRequestMessage::Tool(m) => {
                assert_eq!(
                    m.content,
                    ChatCompletionRequestToolMessageContent::Text("result text".into())
                );
                assert_eq!(m.tool_call_id, "call_123");
            }
            other => panic!("expected Tool message, got {other:?}"),
        }
    }

    #[test]
    fn maps_assistant_tool_call() {
        let call = ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            args: serde_json::json!({"path": "/tmp/a.txt"}),
        };
        let msg = Message::assistant_tool_call(call);
        match map_message(&msg) {
            ChatCompletionRequestMessage::Assistant(m) => {
                assert!(m.content.is_none());
                let calls = m.tool_calls.expect("tool calls present");
                assert_eq!(calls.len(), 1);
                match &calls[0] {
                    ChatCompletionMessageToolCalls::Function(f) => {
                        assert_eq!(f.id, "call_1");
                        assert_eq!(f.function.name, "read_file");
                        assert_eq!(
                            serde_json::from_str::<serde_json::Value>(&f.function.arguments)
                                .unwrap(),
                            serde_json::json!({"path": "/tmp/a.txt"})
                        );
                    }
                    other => panic!("expected Function tool call, got {other:?}"),
                }
            }
            other => panic!("expected Assistant message, got {other:?}"),
        }
    }

    #[test]
    fn maps_tool_spec_to_function_tool() {
        let spec = ToolSpec {
            name: "read_file".into(),
            description: "read a file".into(),
            parameters: serde_json::json!({"type": "object"}),
        };
        match map_tool(&spec) {
            ChatCompletionTools::Function(tool) => {
                assert_eq!(tool.function.name, "read_file");
                assert_eq!(tool.function.description.as_deref(), Some("read a file"));
                assert_eq!(
                    tool.function.parameters,
                    Some(serde_json::json!({"type": "object"}))
                );
            }
            other => panic!("expected Function tool, got {other:?}"),
        }
    }

    #[test]
    fn parses_valid_and_invalid_arguments() {
        assert_eq!(parse_arguments("{\"a\":1}"), serde_json::json!({"a": 1}));
        assert_eq!(
            parse_arguments("not json"),
            serde_json::Value::String("not json".into())
        );
    }

    #[test]
    fn request_wire_format_matches_openai() {
        let llm = test_llm();
        let req = ModelRequest {
            model: "deepseek-chat".into(),
            system: Some("be brief".into()),
            messages: vec![
                Message::user("hi"),
                Message::assistant_tool_call(ToolCall {
                    id: "c1".into(),
                    name: "run_shell".into(),
                    args: serde_json::json!({"cmd": "ls"}),
                }),
                Message::tool_result("c1", "ok"),
            ],
            tools: vec![ToolSpec {
                name: "run_shell".into(),
                description: "run a command".into(),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            }],
            max_tokens: Some(128),
            temperature: Some(0.5),
        };

        let request = llm.build_request(&req);
        let json = serde_json::to_value(&request).unwrap();

        assert_eq!(json["model"], "deepseek-chat");
        assert_eq!(json["stream"], true);
        assert_eq!(json["max_tokens"], 128);

        let roles: Vec<&str> = json["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, vec!["system", "user", "assistant", "tool"]);

        assert_eq!(json["messages"][3]["tool_call_id"], "c1");

        assert_eq!(
            json["messages"][2]["tool_calls"][0]["function"]["name"],
            "run_shell"
        );
        let args = json["messages"][2]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(args).unwrap(),
            serde_json::json!({"cmd": "ls"})
        );

        assert_eq!(json["tools"][0]["type"], "function");
        assert_eq!(json["tools"][0]["function"]["name"], "run_shell");
    }
}
