use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::message::ToolSpec;
// ============================================================================
// 5. Tool seam
// ============================================================================

#[derive(Debug, Clone)]
pub struct ToolInput {
    pub call_id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub call_id: String,
    /// Canonical, machine-readable result value. Never a display rendering.
    pub value: Option<Value>,
    /// Human-readable rendering of the result, decoupled from the canonical
    /// value (W189). None when the canonical value is already the
    /// human-readable form (e.g. read_file's plain text); Some(_) when a
    /// condensed/derived view reads better than the raw value (e.g. run_shell's
    /// stdout+stderr summary).
    pub render: Option<String>,
    pub error: Option<String>,
    /// The guard verdict for this dispatch. Some(Allow) when the guard chain
    /// passed (execution was permitted); Some(Deny(_)) / Some(Ask(_)) when a
    /// guard short-circuited. Makes Deny/Ask first-class result facts instead
    /// of opaque error strings; the error field is retained for back-compat.
    pub decision: Option<ToolDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolDecision {
    Allow,
    Deny(String),
    Ask(String),
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    async fn execute(&self, args: Value) -> Result<Value, String>;
}

/// A guard is the "waterfall" step: it may Allow, Deny, or Ask. Guards run in
/// registration order; the first non-Allow decision short-circuits dispatch.
#[async_trait]
pub trait ToolGuard: Send + Sync {
    async fn check(&self, input: &ToolInput) -> ToolDecision;
}

#[async_trait]
pub trait ToolRegistry: Send + Sync {
    fn register(&mut self, tool: Box<dyn Tool>);
    fn add_guard(&mut self, guard: Box<dyn ToolGuard>);
    fn get(&self, name: &str) -> Option<&dyn Tool>;
    fn schemas(&self) -> Vec<ToolSpec>;
    /// Run the guard chain, then the tool. Errors are captured, not thrown.
    async fn dispatch(&self, input: ToolInput) -> ToolOutput;
}

pub struct ToolRegistryService(pub Arc<dyn ToolRegistry>);
impl std::ops::Deref for ToolRegistryService {
    type Target = dyn ToolRegistry;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_output_render_is_separate_from_value() {
        let out = ToolOutput {
            call_id: "c1".into(),
            value: Some(serde_json::json!({ "stdout": "hi", "stderr": "", "exit_code": 0 })),
            render: Some("exit_code: 0\nstdout: hi".into()),
            error: None,
            decision: Some(ToolDecision::Allow),
        };
        // render is decoupled from value: the human view can differ.
        assert_eq!(out.render.as_deref(), Some("exit_code: 0\nstdout: hi"));
        assert!(matches!(out.value, Some(serde_json::Value::Object(_))));
        assert_eq!(out.error, None);
        assert_eq!(out.decision, Some(ToolDecision::Allow));
    }

    #[test]
    fn tool_output_render_defaults_to_none() {
        // A plain-text result (e.g. read_file) needs no separate render: the
        // canonical value IS the human-readable form.
        let out = ToolOutput {
            call_id: "c2".into(),
            value: Some(serde_json::json!("file contents")),
            render: None,
            error: None,
            decision: Some(ToolDecision::Allow),
        };
        assert_eq!(out.value, Some(serde_json::json!("file contents")));
        assert_eq!(out.render, None);
    }

}
