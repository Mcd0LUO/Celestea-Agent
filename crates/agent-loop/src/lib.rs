//! celestea-agent-loop — default turn/step driver (W104).
//!
//! DefaultAgentLoop implements the celestea_core::AgentLoop seam: it drives
//! one user turn by appending to the session log, looping over model steps,
//! dispatching tool calls through the registry, and writing the final
//! assistant message. All dependencies (llm, session, tools) are resolved
//! from the shared celestea_core::Context at turn start.

use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use celestea_core::{
    AgentConfig, AgentError, AgentLoop, Content, Context, LlmService, ModelRequest,
    SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput, ToolRegistryService,
};
use futures_util::StreamExt;

/// The default agent loop: a stateless (modulo a turn counter) driver.
pub struct DefaultAgentLoop {
    config: AgentConfig,
    /// Monotonic turn id counter; keeps the loop Send + Sync while producing
    /// unique turn ids without any extra dependency.
    turn_id: AtomicU64,
}

impl DefaultAgentLoop {
    /// Build a loop from an AgentConfig.
    pub fn new(config: AgentConfig) -> Self {
        Self { config, turn_id: AtomicU64::new(0) }
    }

    /// Allocate the next unique turn id.
    fn next_turn_id(&self) -> String {
        let n = self.turn_id.fetch_add(1, Ordering::Relaxed);
        format!("turn-{}", n)
    }

    /// Print a streamed text delta to stdout and flush it so the UI updates
    /// incrementally. Printing must not fail the turn.
    fn print_delta(text: &str) {
        print!("{}", text);
        let _ = io::stdout().flush();
    }
}

#[async_trait]
impl AgentLoop for DefaultAgentLoop {
    async fn run_turn(&self, ctx: &Context, user_input: &str) -> Result<(), AgentError> {
        // Resolve required services from the context.
        let llm = ctx
            .get::<LlmService>()
            .ok_or_else(|| AgentError("missing LlmService in context".into()))?;
        let session = ctx
            .get::<SessionService>()
            .ok_or_else(|| AgentError("missing SessionService in context".into()))?;
        let registry = ctx
            .get::<ToolRegistryService>()
            .ok_or_else(|| AgentError("missing ToolRegistryService in context".into()))?;

        // Turn bookkeeping: the session log is the single source of truth.
        let turn_id = self.next_turn_id();
        session.append(SessionEvent::TurnStart { id: turn_id.clone() });
        session.append(SessionEvent::UserMessage { text: user_input.to_string() });

        for _step in 0..self.config.max_steps {
            // History is derived from the log, never stored separately.
            let messages = session.derive_messages();

            let request = ModelRequest {
                model: self.config.model.clone(),
                system: Some(self.config.system_prompt.clone()),
                messages,
                tools: registry.schemas(),
                max_tokens: None,
                temperature: None,
            };

            // Generate, then consume the stream: Text deltas go to stdout,
            // the final Done(message) is the authoritative assistant reply.
            let mut stream = llm
                .generate(request)
                .await
                .map_err(|e| AgentError(format!("llm.generate failed: {}", e)))?;

            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();

            while let Some(event) = stream.next().await {
                match event {
                    StreamEvent::Text(delta) => Self::print_delta(&delta),
                    StreamEvent::Done(message) => {
                        for content in message.content {
                            match content {
                                Content::Text(text) => assistant_text.push_str(&text),
                                Content::ToolCall(call) => tool_calls.push(call),
                            }
                        }
                    }
                }
            }

            if tool_calls.is_empty() {
                // Plain assistant reply ends the turn.
                session.append(SessionEvent::AssistantMessage { text: assistant_text });
                break;
            }

            // Tool-call step. Protocol ordering matters: every tool call in
            // this assistant turn belongs to a single assistant message, so
            // append ALL ToolCall events first, then dispatch and append each
            // ToolResult in turn. Interleaving ToolCall/ToolResult per call
            // would misrepresent the history to the model.
            for call in &tool_calls {
                session.append(SessionEvent::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    args: call.args.clone(),
                });
            }

            for call in &tool_calls {
                let output = registry
                    .dispatch(ToolInput {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        args: call.args.clone(),
                    })
                    .await;

                session.append(SessionEvent::ToolResult {
                    id: output.call_id,
                    value: output.value,
                    error: output.error,
                });
            }
        }

        session.append(SessionEvent::TurnEnd { id: turn_id });
        Ok(())
    }
}

