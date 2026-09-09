//! DeepSeek provider configuration and capability catalog.
//!
//! Owns the plugin-level constants and configuration types for the DeepSeek
//! adapter: the reasoning-effort enum, static model metadata and the provider
//! configuration struct. Kept separate from the client so the request path can
//! stay focused on mapping the core seam onto the OpenAI-compatible wire API.


pub(crate) const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
pub(crate) const DEFAULT_MODEL: &str = "deepseek-chat";
pub(crate) const API_KEY_ENV: &str = "DEEPSEEK_API_KEY";
pub(crate) const BASE_URL_ENV: &str = "DEEPSEEK_BASE_URL";

// W260: reasoning_effort is FREE-FORM (Option<String>, verbatim passthrough).
// User-defined tiers (low/high/max or any provider-specific label) reach the
// upstream exactly as configured - no engine-imposed ceiling or renaming.

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
    pub reasoning_effort: Option<String>,
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
