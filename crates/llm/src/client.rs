//! DeepSeek client: the request path that maps the core Llm seam onto
//! async-openai's chat-completions API and reconstructs the streamed turn
//! (reasoning deltas + text deltas + accumulated tool calls) back into core
//! stream events.
//!
//! Streaming transport is raw SSE (W213): async-openai 0.41.3's typed SSE
//! stream drops the reasoning_content field (see the NOTE on extract_reasoning
//! below), so generate posts the chat-completions request itself through
//! reqwest and decodes the provider's server-sent events with
//! eventsource-stream. Each raw chunk is parsed against the wire shape:
//! reasoning_content becomes StreamEvent::Thinking as it streams in
//! (real-time CoT), content becomes StreamEvent::Text, tool-call fragments
//! accumulate per index, and the turn ends with one authoritative
//! StreamEvent::Done.

use std::collections::BTreeMap;
use std::io;
use std::pin::Pin;

use async_openai::types::chat::{
    ChatCompletionMessageToolCall, ChatCompletionMessageToolCalls,
    ChatCompletionRequestAssistantMessage, ChatCompletionRequestAssistantMessageContent,
    ChatCompletionRequestMessage, ChatCompletionRequestSystemMessage,
    ChatCompletionRequestSystemMessageContent, ChatCompletionRequestToolMessage,
    ChatCompletionRequestToolMessageContent, ChatCompletionRequestUserMessage,
    ChatCompletionRequestUserMessageContent, ChatCompletionTool, ChatCompletionTools,
    CreateChatCompletionRequest, FunctionCall, FunctionObject,
};
use async_stream::stream;
use async_trait::async_trait;
use celestea_core::{
    Content, Llm, LlmError, LlmStream, Message, ModelRequest, Role, StreamEvent, ToolCall, ToolSpec,
};
use eventsource_stream::EventStream;
use futures_util::{Stream, StreamExt};

use crate::config::{
    API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL, DEFAULT_MODEL, DeepSeekConfig, ReasoningEffort,
};

/// DeepSeek provider backed by async-openai (OpenAI-compatible request types).
///
/// Created with DeepSeekLlm::new from a DeepSeekConfig, or with the
/// DeepSeekLlm::from_env convenience path. with_model remains as a back-compat
/// setter for the fallback model. The model passed to a given ModelRequest
/// takes precedence; the configured model is used when the request leaves its
/// model empty. generate requires only a non-empty model name (no hardcoded
/// catalog; the endpoint decides the models).
pub struct DeepSeekLlm {
    /// Raw HTTP transport for the streaming path. Bypasses async-openai's
    /// typed SSE stream, which drops reasoning_content (see the NOTE on
    /// extract_reasoning below).
    http: reqwest::Client,
    /// OpenAI-compatible base URL (e.g. https://api.deepseek.com, optionally
    /// with a /v1 suffix); /chat/completions is appended.
    base_url: String,
    api_key: String,
    model: String,
    reasoning_effort: Option<ReasoningEffort>,
    max_output_tokens: Option<u32>,
}

impl DeepSeekLlm {
    /// Build a provider from an explicit config.
    ///
    /// The constructor is infallible per the pinned API (returns Self), so
    /// model validation that must surface an Err happens on the request path in
    /// DeepSeekLlm::generate (and in the Result-returning from_env); callers
    /// may pre-check with DeepSeekLlm::validate_model.
    pub fn new(config: DeepSeekConfig) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: config.base_url,
            api_key: config.api_key,
            model: config.model,
            reasoning_effort: config.reasoning_effort,
            max_output_tokens: config.max_output_tokens,
        }
    }

    /// Build a client from the environment.
    ///
    /// DEEPSEEK_API_KEY — required; returns LlmError when unset.
    /// DEEPSEEK_BASE_URL — optional; defaults to https://api.deepseek.com.
    /// Model defaults to deepseek-chat and is validated against the catalog.
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
    /// talks to whatever OpenAI-compatible endpoint base_url points at, and
    /// that endpoint decides its own model catalog (e.g. a local shim exposing
    /// deepseek-v4-flash), so there is no hardcoded preset list. The only hard
    /// rule is that a model must be supplied.
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
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&request)
            .send()
            .await
            .map_err(|e| LlmError(format!("failed to start stream: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(LlmError(format!("stream request failed: {status}: {body}")));
        }

        // Raw SSE path: async-openai's typed stream drops reasoning_content
        // (see the NOTE on extract_reasoning), so decode the provider's
        // events ourselves and surface each delta as it streams in.
        let byte_stream = response.bytes_stream().map(|r| r.map_err(io::Error::other));
        let upstream = raw_chunk_stream(byte_stream);

        Ok(stream_events(upstream))
    }
}

/// Decode the raw SSE byte stream of a chat-completions response into
/// RawChunks. The [DONE] sentinel terminates the stream; keepalive events and
/// unparseable payloads are skipped — a provider that does not emit
/// reasoning_content simply yields content chunks (silent degradation, no
/// error).
fn raw_chunk_stream<S, B, E>(byte_stream: S) -> RawChunkStream
where
    S: Stream<Item = Result<B, E>> + Send + 'static,
    B: AsRef<[u8]> + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let mut events = Box::pin(EventStream::new(byte_stream));
    Box::pin(stream! {
        while let Some(ev) = events.next().await {
            let event = match ev {
                Ok(e) => e,
                Err(e) => {
                    // Decode/transport error: stop; the caller emits a Done
                    // with whatever was accumulated (truncated turn).
                    yield Err(format!("sse decode error: {e}"));
                    break;
                }
            };
            if event.data == "[DONE]" {
                break;
            }
            if event.event == "keepalive" {
                continue;
            }
            // Non-JSON data lines (heartbeats, usage-only frames, noise) are
            // skipped silently; only JSON chunks with a delta produce events.
            if let Some(chunk) = parse_raw_chunk(&event.data) {
                yield Ok(chunk);
            }
        }
    })
}

/// Map raw streamed chunks into core StreamEvents (W213).
///
/// Reasoning deltas become StreamEvent::Thinking immediately (real-time CoT),
/// text deltas become StreamEvent::Text, tool calls accumulate per index, and
/// the turn ends with one authoritative StreamEvent::Done. Chunks without any
/// reasoning content pass through untouched (pure text stream). A mid-stream
/// transport error yields a truncated turn: final Done with whatever was
/// accumulated (the stream item type cannot carry an error).
fn stream_events(mut upstream: RawChunkStream) -> LlmStream {
    let s = stream! {
        let mut text = String::new();
        // Tool-call deltas arrive in fragments keyed by index; accumulate
        // id / name / arguments per index and reconstruct in order.
        let mut acc: BTreeMap<u32, ToolCallAcc> = BTreeMap::new();

        while let Some(chunk) = upstream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(_) => break,
            };

            // Real-time chain-of-thought: emit each reasoning delta as it
            // arrives. thinking_event is the W191 seam and gates blank deltas
            // to None; the payload keeps the untouched delta so whitespace
            // between fragments survives live rendering (a per-fragment trim
            // would fuse adjacent tokens).
            if let Some(reasoning) = chunk.reasoning {
                if thinking_event(&reasoning).is_some() {
                    yield StreamEvent::Thinking(reasoning);
                }
            }

            for choice in chunk.choices {
                if let Some(content) = choice.text {
                    if !content.is_empty() {
                        text.push_str(&content);
                        yield StreamEvent::Text(content);
                    }
                }
                for tc in choice.tool_calls {
                    let entry = acc.entry(tc.index).or_default();
                    if let Some(id) = tc.id {
                        entry.id = id;
                    }
                    if let Some(name) = tc.name {
                        entry.name.push_str(&name);
                    }
                    if let Some(arguments) = tc.arguments {
                        entry.arguments.push_str(&arguments);
                    }
                }
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
    Box::pin(s)
}

/// One decoded chat-completions stream chunk (raw wire shape).
#[derive(Debug, Default, PartialEq)]
struct RawChunk {
    /// Joined reasoning_content across choices (None when absent).
    reasoning: Option<String>,
    /// Per-choice content / tool-call deltas, in wire order.
    choices: Vec<RawChoiceDelta>,
}

/// The content + tool_calls part of a single choice's delta.
#[derive(Debug, Default, PartialEq)]
struct RawChoiceDelta {
    text: Option<String>,
    tool_calls: Vec<RawToolCallDelta>,
}

/// One streamed tool-call fragment; id/name/arguments arrive piecemeal per
/// index and are reassembled by index.
#[derive(Debug, Default, PartialEq)]
struct RawToolCallDelta {
    index: u32,
    id: Option<String>,
    name: Option<String>,
    arguments: Option<String>,
}

type RawChunkStream = Pin<Box<dyn Stream<Item = Result<RawChunk, String>> + Send>>;

/// Parse one SSE data payload (a raw chat-completions chunk) into the delta
/// view used by the live loop. Returns None when the payload is not a JSON
/// chunk (heartbeats, usage-only frames, noise) — the caller skips it.
fn parse_raw_chunk(data: &str) -> Option<RawChunk> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let reasoning = extract_reasoning(&value);
    let mut choices: Vec<RawChoiceDelta> = Vec::new();

    if let Some(array) = value.get("choices").and_then(|c| c.as_array()) {
        for choice in array {
            let delta = choice.get("delta");
            let text = delta
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
                .map(|t| t.to_string())
                .filter(|t| !t.is_empty());

            let mut tool_calls = Vec::new();
            if let Some(calls) = delta
                .and_then(|d| d.get("tool_calls"))
                .and_then(|c| c.as_array())
            {
                for tc in calls {
                    let function = tc.get("function");
                    tool_calls.push(RawToolCallDelta {
                        index: tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32,
                        id: tc.get("id").and_then(|i| i.as_str()).map(str::to_string),
                        name: function
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .map(str::to_string),
                        arguments: function
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| a.as_str())
                            .map(str::to_string),
                    });
                }
            }

            if text.is_some() || !tool_calls.is_empty() {
                choices.push(RawChoiceDelta { text, tool_calls });
            }
        }
    }

    if reasoning.is_none() && choices.is_empty() {
        None
    } else {
        Some(RawChunk { reasoning, choices })
    }
}

/// Build a StreamEvent::Thinking out of a non-empty reasoning string, if any.
///
/// Chain-of-thought deltas are surfaced as their own StreamEvent so a consumer
/// can tell reasoning from the final answer. Empty/whitespace reasoning yields
/// None (nothing to emit). The live loop (W213) uses this as the blank-gate
/// for each streamed reasoning delta while keeping the yielded Thinking
/// payload untrimmed, so whitespace between fragments survives live rendering.
fn thinking_event(reasoning: &str) -> Option<StreamEvent> {
    let r = reasoning.trim();
    if r.is_empty() {
        None
    } else {
        Some(StreamEvent::Thinking(r.to_string()))
    }
}

/// Extract the chain-of-thought text from a streamed chat-completions chunk's
/// raw JSON. DeepSeek streams the CoT in choices[0].delta.reasoning_content
/// (absent for non-reasoning models). Given the chunk verbatim it returns the
/// joined reasoning text, or None when the chunk carries none.
///
/// NOTE (W191, source-verified; wired live in W213): async-openai 0.41.3's
/// typed stream drops this field — its ChatCompletionStreamResponseDelta models
/// only content / function_call / tool_calls / role / refusal (chat_.rs) — so
/// generate() no longer uses that typed stream at all. It posts the raw SSE
/// request itself through reqwest and feeds each event's data through
/// parse_raw_chunk, which uses this mapper; reasoning_content therefore reaches
/// the live loop and is emitted as StreamEvent::Thinking while the stream is
/// still open.
fn extract_reasoning(chunk: &serde_json::Value) -> Option<String> {
    let deltas = chunk.get("choices")?.as_array()?;
    let mut parts: Vec<String> = Vec::new();
    for choice in deltas {
        if let Some(r) = choice.get("delta").and_then(|d| d.get("reasoning_content")) {
            if let Some(t) = r.as_str() {
                if !t.is_empty() {
                    parts.push(t.to_string());
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
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
    use std::sync::Arc;
    use crate::registry::deepseek_registry;
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

    // ---- W191: StreamEvent::Thinking mapping (chain-of-thought) ---------------

    #[test]
    fn thinking_event_maps_non_empty_reasoning() {
        // Non-empty reasoning -> StreamEvent::Thinking (whitespace-trimmed).
        let ev = thinking_event("  Let me reconsider.  ").unwrap();
        assert!(matches!(ev, StreamEvent::Thinking(_)));
        if let StreamEvent::Thinking(t) = ev {
            assert_eq!(t, "Let me reconsider.");
        }
    }

    #[test]
    fn thinking_event_none_for_empty_or_blank() {
        assert!(thinking_event("").is_none());
        assert!(thinking_event("   ").is_none());
        assert!(thinking_event("\n\t").is_none());
    }

    #[test]
    fn extract_reasoning_reads_deepseek_reasoning_content() {
        // A chunk shaped like DeepSeek's streamed reasoning delta.
        let chunk = serde_json::json!({
            "id": "chunk-1",
            "choices": [{
                "index": 0,
                "delta": { "reasoning_content": "Let me trace the steps." },
                "finish_reason": null
            }]
        });
        assert_eq!(
            extract_reasoning(&chunk).as_deref(),
            Some("Let me trace the steps.")
        );
    }

    #[test]
    fn extract_reasoning_concatenates_multi_choice_reasoning_in_order() {
        // Multi-choice reasoning deltas join in array order.
        let chunk = serde_json::json!({
            "choices": [
                { "index": 0, "delta": { "reasoning_content": "ab" } },
                { "index": 1, "delta": { "reasoning_content": "cd" } }
            ]
        });
        assert_eq!(extract_reasoning(&chunk).as_deref(), Some("abcd"));
    }

    #[test]
    fn extract_reasoning_none_when_absent() {
        // A normal final-answer chunk carries no reasoning_content.
        let chunk = serde_json::json!({
            "choices": [{ "index": 0, "delta": { "content": "hello" } }]
        });
        assert!(extract_reasoning(&chunk).is_none());
        // Malformed / empty chunks also yield None (no panic).
        assert!(extract_reasoning(&serde_json::json!({})).is_none());
        assert!(extract_reasoning(&serde_json::json!({"choices": []})).is_none());
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

    // ---- W213: live reasoning_content over raw SSE --------------------------

    #[test]
    fn parse_raw_chunk_reads_reasoning_content() {
        let chunk = parse_raw_chunk(
            r#"{"choices":[{"index":0,"delta":{"reasoning_content":"Let me trace the steps."}}]}"#,
        )
        .unwrap();
        assert_eq!(chunk.reasoning.as_deref(), Some("Let me trace the steps."));
        assert!(chunk.choices.is_empty());
    }

    #[test]
    fn parse_raw_chunk_extracts_content_tools_and_reasoning_together() {
        let chunk = parse_raw_chunk(
            r#"{"choices":[{"index":0,"delta":{"reasoning_content":"r1","content":"hi",
                "tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"path\":\"/tmp/a\"}"}}]}}]}"#,
        )
        .unwrap();
        assert_eq!(chunk.reasoning.as_deref(), Some("r1"));
        assert_eq!(chunk.choices.len(), 1);
        let choice = &chunk.choices[0];
        assert_eq!(choice.text.as_deref(), Some("hi"));
        assert_eq!(choice.tool_calls.len(), 1);
        let tc = &choice.tool_calls[0];
        assert_eq!(tc.index, 0);
        assert_eq!(tc.id.as_deref(), Some("call_1"));
        assert_eq!(tc.name.as_deref(), Some("read_file"));
        assert_eq!(tc.arguments.as_deref(), Some("{\"path\":\"/tmp/a\"}"));
    }

    #[test]
    fn parse_raw_chunk_none_for_non_json_or_non_chunk_payloads() {
        assert!(parse_raw_chunk("not json").is_none());
        assert!(parse_raw_chunk("[DONE]").is_none());
        assert!(parse_raw_chunk(r#"{"choices":[]}"#).is_none());
        // A usage-only final frame has no choices and no delta.
        assert!(parse_raw_chunk(r#"{"object":"usage","usage":{}}"#).is_none());
    }

    #[tokio::test]
    async fn raw_chunk_stream_decodes_sse_in_order_and_stops_at_done() {
        // Two SSE frames drive the parser across an incomplete-frame boundary,
        // a keepalive comment, CRLF line endings and the [DONE] sentinel.
        let sse = concat!(
            r#"data: {"choices":[{"delta":{"reasoning_content":"Let me"}}]}"#,
            "\n\n",
            ": keepalive\n\n",
            r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#,
            "\r\n\r\n",
            "data: [DONE]\n\n",
            // Must be ignored: the stream already terminated at [DONE].
            r#"data: {"choices":[{"delta":{"content":"late"}}]}"#,
            "\n\n",
        );
        let split = sse.find("\n\n: keepalive").unwrap();
        let byte_stream = futures_util::stream::iter(vec![
            Ok::<Vec<u8>, io::Error>(sse[..split].as_bytes().to_vec()),
            Ok::<Vec<u8>, io::Error>(sse[split..].as_bytes().to_vec()),
        ]);
        let mut chunks = raw_chunk_stream(byte_stream);
        let mut got = Vec::new();
        while let Some(chunk) = chunks.next().await {
            got.push(chunk.unwrap());
        }
        assert_eq!(got.len(), 2, "expected thinking + text chunks only");
        assert_eq!(got[0].reasoning.as_deref(), Some("Let me"));
        assert_eq!(got[1].choices[0].text.as_deref(), Some("Hi"));
    }

    #[tokio::test]
    async fn stream_events_emits_thinking_in_real_time_before_final_answer() {
        let chunks: Vec<Result<RawChunk, String>> = vec![
            Ok(RawChunk { reasoning: Some("Let me".into()), choices: vec![] }),
            Ok(RawChunk { reasoning: Some(" think".into()), choices: vec![] }),
            Ok(RawChunk {
                reasoning: None,
                choices: vec![RawChoiceDelta { text: Some("Hello".into()), tool_calls: vec![] }],
            }),
        ];
        let mut stream = stream_events(Box::pin(futures_util::stream::iter(chunks)));
        let mut events: Vec<StreamEvent> = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 4, "Thinking x2 + Text + Done");
        assert!(matches!(&events[0], StreamEvent::Thinking(t) if t == "Let me"));
        // Fragment boundaries are preserved (untrimmed) for live rendering.
        assert!(matches!(&events[1], StreamEvent::Thinking(t) if t == " think"));
        assert!(matches!(&events[2], StreamEvent::Text(t) if t == "Hello"));
        match &events[3] {
            StreamEvent::Done(m) => {
                assert_eq!(m.role, Role::Assistant);
                assert_eq!(m.content.len(), 1);
                assert!(matches!(&m.content[0], Content::Text(t) if t == "Hello"));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_events_without_reasoning_degrades_to_pure_text() {
        let chunks: Vec<Result<RawChunk, String>> = vec![
            Ok(RawChunk {
                reasoning: None,
                choices: vec![RawChoiceDelta { text: Some("a".into()), tool_calls: vec![] }],
            }),
            Ok(RawChunk {
                reasoning: None,
                choices: vec![RawChoiceDelta { text: Some("b".into()), tool_calls: vec![] }],
            }),
        ];
        let mut stream = stream_events(Box::pin(futures_util::stream::iter(chunks)));
        let mut events: Vec<StreamEvent> = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 3, "Text x2 + Done, nothing for reasoning");
        assert!(events.iter().all(|e| !matches!(e, StreamEvent::Thinking(_))));
        match &events[2] {
            StreamEvent::Done(m) => {
                assert!(matches!(&m.content.as_slice(), [Content::Text(t)] if t == "ab"));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_events_accumulates_tool_calls_alongside_reasoning() {
        let chunks: Vec<Result<RawChunk, String>> = vec![
            Ok(RawChunk { reasoning: Some("r1".into()), choices: vec![] }),
            Ok(RawChunk {
                reasoning: Some("r2".into()),
                choices: vec![RawChoiceDelta {
                    text: None,
                    tool_calls: vec![RawToolCallDelta {
                        index: 0,
                        id: Some("call_1".into()),
                        name: Some("read_file".into()),
                        arguments: Some("{\"pa".into()),
                    }],
                }],
            }),
            Ok(RawChunk {
                reasoning: None,
                choices: vec![RawChoiceDelta {
                    text: None,
                    tool_calls: vec![RawToolCallDelta {
                        index: 0,
                        id: None,
                        name: None,
                        arguments: Some("th\":\"/tmp/a\"}".into()),
                    }],
                }],
            }),
        ];
        let mut stream = stream_events(Box::pin(futures_util::stream::iter(chunks)));
        let mut events: Vec<StreamEvent> = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 3, "Thinking x2 + Done with tool call");
        match &events[2] {
            StreamEvent::Done(m) => {
                assert_eq!(m.content.len(), 1);
                match &m.content[0] {
                    Content::ToolCall(tc) => {
                        assert_eq!(tc.id, "call_1");
                        assert_eq!(tc.name, "read_file");
                        assert_eq!(tc.args, serde_json::json!({"path": "/tmp/a"}));
                    }
                    other => panic!("expected ToolCall, got {other:?}"),
                }
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn sse_pipeline_emits_thinking_before_text_end_to_end() {
        // Bytes-level pipeline: raw SSE body -> raw_chunk_stream ->
        // stream_events. Reasoning deltas surface as Thinking while the stream
        // is still open, i.e. before Text/Done.
        let sse = concat!(
            r#"data: {"choices":[{"delta":{"reasoning_content":"Let me"}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{"reasoning_content":" think"}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#,
            "\n\n",
            "data: [DONE]\n\n",
        );
        let byte_stream = futures_util::stream::iter(vec![
            Ok::<Vec<u8>, io::Error>(sse.as_bytes().to_vec()),
        ]);
        let mut stream = stream_events(raw_chunk_stream(byte_stream));
        let mut events: Vec<StreamEvent> = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 4, "Thinking x2 + Text + Done");
        assert!(matches!(&events[0], StreamEvent::Thinking(t) if t == "Let me"));
        assert!(matches!(&events[1], StreamEvent::Thinking(t) if t == " think"));
        assert!(matches!(&events[2], StreamEvent::Text(t) if t == "Hi"));
        match &events[3] {
            StreamEvent::Done(m) => {
                assert!(matches!(&m.content.as_slice(), [Content::Text(t)] if t == "Hi"));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stream_events_skips_blank_reasoning_deltas() {
        let chunks: Vec<Result<RawChunk, String>> = vec![
            Ok(RawChunk { reasoning: Some("   ".into()), choices: vec![] }),
            Ok(RawChunk { reasoning: Some("ok".into()), choices: vec![] }),
        ];
        let mut stream = stream_events(Box::pin(futures_util::stream::iter(chunks)));
        let mut events: Vec<StreamEvent> = Vec::new();
        while let Some(ev) = stream.next().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 2, "only the non-blank Thinking + Done");
        assert!(matches!(&events[0], StreamEvent::Thinking(t) if t == "ok"));
        assert!(matches!(&events[1], StreamEvent::Done(_)));
    }
}

