use std::sync::Arc;

use async_trait::async_trait;
use crate::message::{LlmError, LlmStream, ModelRequest};
#[async_trait]
pub trait Llm: Send + Sync {
    async fn generate(&self, req: ModelRequest) -> Result<LlmStream, LlmError>;
}

/// Newtype so Arc<dyn Llm> can live in the Context TypeId map.
pub struct LlmService(pub Arc<dyn Llm>);
impl std::ops::Deref for LlmService {
    type Target = dyn Llm;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

/// A named registry of LLM adapters — the multi-provider seam (W189).
///
/// Mirrors the NamedRegistry "patch" semantics: registration is append-only and
/// a later registration of the same name shadows the earlier one for
/// LlmRegistry::resolve. Compose code registers each provider under a stable
/// name (e.g. "deepseek") and routes requests by name; consumers that still
/// read the single LlmService adapter keep working unchanged.
#[derive(Default)]
pub struct LlmRegistry {
    rows: Vec<(String, Arc<dyn Llm>)>,
}

impl LlmRegistry {
    /// Register (or shadow) a provider adapter under name.
    pub fn register(&mut self, name: impl Into<String>, llm: Arc<dyn Llm>) {
        self.rows.push((name.into(), llm));
    }

    /// Resolve the adapter registered for name (last registration wins), or
    /// None when no adapter was registered under that name.
    pub fn resolve(&self, name: &str) -> Option<Arc<dyn Llm>> {
        self.rows.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }

    /// The distinct provider names currently registered, in first-registration
    /// order (a shadowed name is reported once).
    pub fn list(&self) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for (n, _) in &self.rows {
            if !seen.contains(n) {
                seen.push(n.clone());
            }
        }
        seen
    }
}

/// Newtype so Arc<LlmRegistry> can live in the Context TypeId map, in the same
/// style as LlmService / ToolRegistryService.
pub struct LlmRegistryService(pub Arc<LlmRegistry>);
impl std::ops::Deref for LlmRegistryService {
    type Target = LlmRegistry;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct NoopLlm;
    #[async_trait]
    impl Llm for NoopLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            Err(LlmError("noop".into()))
        }
    }

    #[test]
    fn llm_registry_register_resolve_last_wins() {
        let mut reg = LlmRegistry::default();
        reg.register("deepseek", Arc::new(NoopLlm));
        reg.register("openai", Arc::new(NoopLlm));
        // re-register the same name: last wins (patch semantics)
        reg.register("deepseek", Arc::new(NoopLlm));

        assert!(reg.resolve("deepseek").is_some());
        assert!(reg.resolve("openai").is_some());
        assert!(reg.resolve("anthropic").is_none());
        // the resolved adapter is directly usable as Arc<dyn Llm>
        let _llm: Arc<dyn Llm> = reg.resolve("deepseek").unwrap();
    }

    #[test]
    fn llm_registry_list_reports_distinct_names_in_order() {
        let mut reg = LlmRegistry::default();
        reg.register("deepseek", Arc::new(NoopLlm));
        reg.register("openai", Arc::new(NoopLlm));
        reg.register("deepseek", Arc::new(NoopLlm)); // shadowed, listed once
        assert_eq!(reg.list(), vec!["deepseek".to_string(), "openai".to_string()]);
        // empty registry lists nothing
        assert!(LlmRegistry::default().list().is_empty());
    }

    #[test]
    fn llm_registry_service_derefs_to_registry() {
        let mut reg = LlmRegistry::default();
        reg.register("deepseek", Arc::new(NoopLlm));
        let svc = LlmRegistryService(Arc::new(reg));
        // Deref exposes the registry, so the newtype works in the Context map.
        assert_eq!(svc.list(), vec!["deepseek".to_string()]);
        assert!(svc.resolve("deepseek").is_some());
    }

}
