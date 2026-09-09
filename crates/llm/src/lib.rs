//! celestea-llm — DeepSeek provider (W101).
//!
//! Implements the celestea_core::Llm seam on top of async-openai 0.41, which
//! speaks the OpenAI-compatible HTTP API that DeepSeek exposes. Streaming is
//! handled by a raw SSE transport (reqwest + eventsource-stream): async-openai
//! 0.41.3's typed stream drops reasoning_content, so this crate decodes the
//! provider's chunks itself and maps them back into StreamEvent::Thinking
//! (real-time CoT) and StreamEvent::Text deltas plus a single final
//! StreamEvent::Done message.
//!
//! The model-adapter types live here, not in `celestea-core`: the adapter is a
//! replaceable plugin, so its configuration and capability catalog are plugin
//! concerns. The provider is configured with [`DeepSeekConfig`] (either built
//! directly and passed to [`DeepSeekLlm::new`], or assembled from the
//! environment by [`DeepSeekLlm::from_env`]). The model catalog is not
//! hardcoded here: the provider talks to whatever OpenAI-compatible endpoint
//! `base_url` points at, which decides its own catalog. `generate` only
//! requires a non-empty model name.
//!
//! W266: requests are bounded per stage — a connect timeout, a
//! response-headers timeout and an SSE stream idle timeout (see
//! [`DeepSeekConfig`]). There is deliberately no total-request timeout, so a
//! long generation is never killed; a wedged upstream surfaces as a
//! structured timeout error instead of hanging the turn forever.

//! [`LlmError`] that lists the supported ones.
//!
//! Reasoning: `reasoning_effort` from the config is mapped onto the request.
//! DeepSeek accepts `max_tokens` (not OpenAI's `max_completion_tokens`); for
//! `deepseek-reasoner` the field caps the final answer — the CoT
//! (`reasoning_content`) runs on top and is not counted against the context.

mod client;
mod config;
mod registry;

pub use config::{
    CONNECT_TIMEOUT_ENV, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS, DeepSeekConfig, ModelInfo, RESPONSE_TIMEOUT_ENV,
    STREAM_IDLE_TIMEOUT_ENV,
};
pub use client::{DeepSeekLlm, TIMEOUT_ERROR_PREFIX};
pub use registry::deepseek_registry;
