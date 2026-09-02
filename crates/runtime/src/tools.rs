//! Tool registration (W214): the runtime tool face — builtin file tools plus
//! the three worker-orchestration tools, bound to the shared [WorkerRegistry].

use std::sync::Arc;

use celestea_core::ToolRegistry;
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use celestea_workers::{worker_tools_with, WorkerRegistry};

/// Register every tool the runtime surfaces into a registry: the builtin file
/// tools plus the worker-orchestration tools, all bound to the shared
/// [WorkerRegistry]. Used by both [crate::Runtime::compose] (the real agent
/// tool face) and any frontend listing the tool surface, so the two can never
/// drift.
pub fn register_all_tools(registry: &mut ToolRegistryImpl, workers: Arc<WorkerRegistry>) {
    for tool in builtin_tools() {
        registry.register(tool);
    }
    for tool in worker_tools_with(workers) {
        registry.register(tool);
    }
}

