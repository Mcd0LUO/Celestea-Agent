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

//! [`LlmError`] that lists the supported ones.
//!
//! Reasoning: `reasoning_effort` from the config is mapped onto the request.
//! DeepSeek accepts `max_tokens` (not OpenAI's `max_completion_tokens`); for
//! `deepseek-reasoner` the field caps the final answer — the CoT
//! (`reasoning_content`) runs on top and is not counted against the context.

mod client;
mod config;
mod registry;

pub use config::{DeepSeekConfig, ModelInfo, ReasoningEffort};
pub use client::DeepSeekLlm;
pub use registry::deepseek_registry;
