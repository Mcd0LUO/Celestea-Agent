//! DeepSeek provider registry.

use std::sync::Arc;

use celestea_core::LlmRegistry;

use crate::client::DeepSeekLlm;

/// Convenience: a default LlmRegistry with the DeepSeek provider registered
/// under the canonical name "deepseek" (W189). Compose code can register further
/// providers on top; a later registration of the same name shadows the earlier
/// one, per the patch semantics.
pub fn deepseek_registry(llm: DeepSeekLlm) -> LlmRegistry {
    let mut reg = LlmRegistry::default();
    reg.register("deepseek", Arc::new(llm));
    reg
}
