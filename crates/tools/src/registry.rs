//! The `ToolRegistryImpl`: a name-keyed map of tools plus an ordered guard
//! chain run ahead of every dispatch.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use celestea_core::{Tool, ToolDecision, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolSpec};

use crate::builtin::human_render;

/// Concrete `ToolRegistry`: tools keyed by name, guards run in registration
/// order ahead of every dispatch. Thread-safe via interior `Arc`s.
#[derive(Default)]
pub struct ToolRegistryImpl {
    tools: HashMap<String, Arc<dyn Tool>>,
    guards: Vec<Arc<dyn ToolGuard>>,
}

impl ToolRegistryImpl {
    pub fn new() -> Self {
        Self { tools: HashMap::new(), guards: Vec::new() }
    }
}

#[async_trait]
impl ToolRegistry for ToolRegistryImpl {
    fn register(&mut self, tool: Box<dyn Tool>) {
        let spec = tool.spec();
        self.tools.insert(spec.name, Arc::from(tool));
    }

    fn add_guard(&mut self, guard: Box<dyn ToolGuard>) {
        self.guards.push(Arc::from(guard));
    }

    fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.get(name).map(|a| &**a as &dyn Tool)
    }

    fn schemas(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self.tools.values().map(|t| t.spec()).collect();
        specs.sort_by(|a, b| a.name.cmp(&b.name));
        specs
    }

    /// Run the guard chain in order; the first non-`Allow` decision
    /// short-circuits. If all guards allow, look the tool up and execute it.
    /// Failures are captured into `ToolOutput::error`, never thrown.
    async fn dispatch(&self, input: ToolInput) -> ToolOutput {
        let call_id = input.call_id.clone();

        for guard in &self.guards {
            match guard.check(&input).await {
                ToolDecision::Allow => {}
                ToolDecision::Deny(reason) => {
                    return ToolOutput {
                        call_id,
                        value: None,
                        render: None,
                        error: Some(format!("denied: {reason}")),
                        decision: Some(ToolDecision::Deny(reason)),
                    };
                }
                ToolDecision::Ask(question) => {
                    return ToolOutput {
                        call_id,
                        value: None,
                        render: None,
                        error: Some(format!("ask: {question}")),
                        decision: Some(ToolDecision::Ask(question)),
                    };
                }
            }
        }

        let tool = match self.get(&input.name) {
            Some(tool) => tool,
            None => {
                return ToolOutput {
                    call_id,
                    value: None,
                    render: None,
                    error: Some(format!("unknown tool: {}", input.name)),
                    decision: Some(ToolDecision::Allow),
                };
            }
        };

        match tool.execute(input.args).await {
            Ok(value) => {
                let render = human_render(&value);
                ToolOutput {
                    call_id,
                    value: Some(value),
                    render,
                    error: None,
                    decision: Some(ToolDecision::Allow),
                }
            }
            Err(e) => ToolOutput {
                call_id,
                value: None,
                render: None,
                error: Some(e),
                decision: Some(ToolDecision::Allow),
            },
        }
    }
}
