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

// W266: LLM request timeouts. The engine used to build a bare
// `reqwest::Client::new()` — no connect timeout, no response-header timeout and
// no stream idle timeout — so a wedged upstream (TCP accepted, request never
// answered) parked a whole turn forever. Three separate knobs fix that without
// introducing a total-request timeout, which would kill long generations:
//
//   * connect timeout      — TCP/TLS handshake only (DEFAULT_CONNECT_TIMEOUT_MS);
//   * response-header time — from send() to the response headers
//                            (DEFAULT_RESPONSE_TIMEOUT_MS);
//   * stream idle time     — after the SSE stream is open, the gap between any
//                            two data chunks (DEFAULT_STREAM_IDLE_TIMEOUT_MS).
//
// A healthy generation keeps emitting tokens, so only a stalled upstream trips
// the idle guard. 0 disables the corresponding timeout. Values are configurable
// per profile key (`llm_connect_timeout_ms` / `llm_response_timeout_ms` /
// `llm_stream_idle_timeout_ms`, see celestea-runtime::config) and by the env
// vars below, with the env var taking precedence over the profile key.
pub const CONNECT_TIMEOUT_ENV: &str = "CELESTEA_LLM_CONNECT_TIMEOUT_MS";
pub const RESPONSE_TIMEOUT_ENV: &str = "CELESTEA_LLM_RESPONSE_TIMEOUT_MS";
pub const STREAM_IDLE_TIMEOUT_ENV: &str = "CELESTEA_LLM_STREAM_IDLE_TIMEOUT_MS";

/// Default TCP/TLS connect timeout (15s — safe: connects are fast when healthy).
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 15_000;
/// Default send() -> response-headers timeout (60s).
pub const DEFAULT_RESPONSE_TIMEOUT_MS: u64 = 60_000;
/// Default SSE inter-chunk idle timeout (90s; a live generation streams tokens
/// continuously, so this only trips on a genuinely stalled upstream).
pub const DEFAULT_STREAM_IDLE_TIMEOUT_MS: u64 = 90_000;

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
    /// TCP/TLS connect timeout in milliseconds (W266). 0 disables it.
    /// Default: DEFAULT_CONNECT_TIMEOUT_MS (15s).
    pub connect_timeout_ms: u64,
    /// send() -> response-headers timeout in milliseconds (W266): how long the
    /// upstream may take to start answering. 0 disables it.
    /// Default: DEFAULT_RESPONSE_TIMEOUT_MS (60s).
    pub response_timeout_ms: u64,
    /// SSE stream idle timeout in milliseconds (W266): the maximum gap between
    /// two data chunks once the stream is open. 0 disables it.
    /// Default: DEFAULT_STREAM_IDLE_TIMEOUT_MS (90s).
    pub stream_idle_timeout_ms: u64,
}

impl Default for DeepSeekConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key: String::new(),
            model: DEFAULT_MODEL.to_string(),
            reasoning_effort: None,
            max_output_tokens: None,
            connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
            response_timeout_ms: DEFAULT_RESPONSE_TIMEOUT_MS,
            stream_idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        }
    }
}

impl std::fmt::Debug for DeepSeekConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeepSeekConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .field("model", &self.model)
            .field("reasoning_effort", &self.reasoning_effort)
            .field("max_output_tokens", &self.max_output_tokens)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .field("response_timeout_ms", &self.response_timeout_ms)
            .field("stream_idle_timeout_ms", &self.stream_idle_timeout_ms)
            .finish()
    }
}
