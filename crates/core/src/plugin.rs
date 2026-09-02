use crate::context::Context;

/// A plugin mounts itself by providing services, tools, and event listeners.
/// Everything in the harness — the model adapter, the session log, the tool
/// registry, even the agent loop — is a plugin.
pub trait Plugin: Send + Sync + 'static {
    fn name(&self) -> &'static str {
        std::any::type_name::<Self>()
    }
    fn mount(&self, ctx: &mut Context);
}
