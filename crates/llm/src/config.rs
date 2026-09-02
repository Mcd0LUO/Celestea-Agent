//! DeepSeek provider configuration and capability catalog.
//!
//! Owns the plugin-level constants and configuration types for the DeepSeek
//! adapter: the reasoning-effort enum, static model metadata and the provider
//! configuration struct. Kept separate from the client so the request path can
//! stay focused on mapping the core seam onto the OpenAI-compatible wire API.

use serde::{Deserialize, Serialize};

pub(crate) const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
pub(crate) const DEFAULT_MODEL: &str = "deepseek-chat";
pub(crate) const API_KEY_ENV: &str = "DEEPSEEK_API_KEY";
pub(crate) const BASE_URL_ENV: &str = "DEEPSEEK_BASE_URL";

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
