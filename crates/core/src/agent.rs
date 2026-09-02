use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;

use crate::context::Context;
// ============================================================================
// 6. Agent loop seam
// ============================================================================

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub model: String,
    pub system_prompt: String,
    pub max_steps: usize,
    pub max_parallel_tool_calls: usize,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            model: "deepseek-chat".into(),
            system_prompt:
                "You are celestea, an AI agent. You are concise, accurate and direct."
                    .into(),
            max_steps: 16,
            max_parallel_tool_calls: 4,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentError(pub String);

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for AgentError {}

#[async_trait]
pub trait AgentLoop: Send + Sync {
    /// Drive one user turn: append to the session log, loop over model steps,
    /// dispatch tool calls, and write the final assistant message.
    async fn run_turn(&self, ctx: &Context, user_input: &str) -> Result<(), AgentError>;
}

pub struct AgentLoopService(pub Arc<dyn AgentLoop>);
impl std::ops::Deref for AgentLoopService {
    type Target = dyn AgentLoop;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agent_config_default_has_explicit_identity() {
        let cfg = AgentConfig::default();
        // C·identity: the default system prompt states an explicit agent identity
        // instead of the old generic "helpful assistant" boilerplate.
        assert!(
            cfg.system_prompt.contains("celestea"),
            "default system_prompt should name the agent identity, got: {}",
            cfg.system_prompt
        );
        assert!(cfg.system_prompt.contains("concise"));
        assert!(!cfg.system_prompt.contains("helpful assistant"));
    }

}
