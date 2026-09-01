//! celestea-llm — DeepSeek provider (W101).
//!
//! Implements the celestea_core::Llm seam on top of async-openai 0.41, which
//! speaks the OpenAI-compatible HTTP API that DeepSeek exposes. Streaming is
//! handled by async-openai's SSE parser; this crate translates the core seam
//! types (Message, ToolSpec, ModelRequest) into a chat-completions request and
//! maps the streamed chunks back into StreamEvent::Text deltas plus a single
//! final StreamEvent::Done message.
//!
//! Reasoning/thinking fields are deliberately ignored (not mapped).

use std::collections::BTreeMap;

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
    Content, Llm, LlmError, LlmStream, Message, ModelRequest, Role, StreamEvent, ToolCall, ToolSpec,
};
use futures_util::StreamExt;

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-chat";
const API_KEY_ENV: &str = "DEEPSEEK_API_KEY";
const BASE_URL_ENV: &str = "DEEPSEEK_BASE_URL";

/// DeepSeek provider backed by async-openai (OpenAI-compatible).
///
/// Created with DeepSeekLlm::from_env and configured with DeepSeekLlm::with_model.
/// The model passed to a given ModelRequest takes precedence; with_model only
/// sets the fallback used when the request leaves its model empty.
pub struct DeepSeekLlm {
    client: Client<OpenAIConfig>,
    model: String,
}

impl DeepSeekLlm {
    /// Build a client from the environment.
    ///
    /// DEEPSEEK_API_KEY — required; returns LlmError when unset.
    /// DEEPSEEK_BASE_URL — optional; defaults to https://api.deepseek.com.
    pub fn from_env() -> Result<Self, LlmError> {
        let api_key = std::env::var(API_KEY_ENV)
            .map_err(|_| LlmError(format!("{API_KEY_ENV} is not set")))?;
        let api_base = std::env::var(BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());

        let config = OpenAIConfig::new()
            .with_api_base(api_base)
            .with_api_key(api_key);
        let client = Client::with_config(config);

        Ok(Self {
            client,
            model: DEFAULT_MODEL.to_string(),
        })
    }

    /// Set the model used when a ModelRequest does not specify one.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    fn effective_model(&self, req: &ModelRequest) -> String {
        if req.model.is_empty() {
            self.model.clone()
        } else {
            req.model.clone()
        }
    }

    #[allow(deprecated)] // max_tokens is what DeepSeek accepts (not max_completion_tokens)
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

        CreateChatCompletionRequest {
            model: self.effective_model(req),
            messages,
            tools: if tools.is_empty() { None } else { Some(tools) },
            max_tokens: req.max_tokens,
            temperature: req.temperature,
            stream: Some(true),
            ..Default::default()
        }
    }
}

#[async_trait]
impl Llm for DeepSeekLlm {
    async fn generate(&self, req: ModelRequest) -> Result<LlmStream, LlmError> {
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

                    // delta.role, delta.refusal and any reasoning/thinking
                    // fields are intentionally ignored.
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
        let llm = DeepSeekLlm {
            client: Client::with_config(OpenAIConfig::new().with_api_key("sk-test")),
            model: "deepseek-chat".into(),
        };
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
