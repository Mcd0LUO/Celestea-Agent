use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::Arc;

/// Shared, TypeId-keyed service container. Plugins provide services into it;
/// consumers resolve services out of it. A parent chain lets one agent carry a
/// scoped Context layered over the global one (later per-agent presets).
#[derive(Default)]
pub struct Context {
    services: HashMap<TypeId, Arc<dyn Any + Send + Sync>>,
    parent: Option<Arc<Context>>,
}

impl Context {
    pub fn new() -> Self {
        Self { services: HashMap::new(), parent: None }
    }

    /// Register a service. A later registration of the same type replaces an
    /// earlier one (the "patch" semantics in miniature).
    pub fn provide<T: Any + Send + Sync>(&mut self, svc: T) {
        self.services.insert(TypeId::of::<T>(), Arc::new(svc));
    }

    /// Resolve a service by type, falling back to the parent scope.
    pub fn get<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        self.services
            .get(&TypeId::of::<T>())
            .and_then(|a| a.clone().downcast::<T>().ok())
            .or_else(|| self.parent.as_ref().and_then(|p| p.get::<T>()))
    }

    /// Create a child scope that falls back to this context. Each agent gets one.
    pub fn scoped(self: &Arc<Self>) -> Context {
        Context { services: HashMap::new(), parent: Some(self.clone()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn context_provide_get_roundtrip() {
        let mut ctx = Context::new();
        ctx.provide(42u64);
        assert_eq!(*ctx.get::<u64>().unwrap(), 42u64);
        assert!(ctx.get::<String>().is_none());
    }

    #[test]
    fn context_later_provide_replaces_earlier() {
        let mut ctx = Context::new();
        ctx.provide("first".to_string());
        ctx.provide("second".to_string());
        assert_eq!(ctx.get::<String>().unwrap().as_str(), "second");
    }

    #[test]
    fn context_scoped_falls_back_and_shadows() {
        let mut parent = Context::new();
        parent.provide("parent".to_string());
        parent.provide(7u64);
        let parent = Arc::new(parent);
        let mut child = parent.scoped();
        // falls back to parent
        assert_eq!(child.get::<String>().unwrap().as_str(), "parent");
        // child shadows parent for the same type
        child.provide(9u64);
        assert_eq!(*child.get::<u64>().unwrap(), 9u64);
        // parent is unchanged
        assert_eq!(*parent.get::<u64>().unwrap(), 7u64);
    }

}
