//! Tool registration (W214): the runtime tool face — builtin file tools plus
//! the three worker-orchestration tools, bound to the shared [WorkerRegistry].

use std::sync::Arc;

use celestea_core::ToolRegistry;
use celestea_tools::{builtin_tools_with, mount_production_guards, ProcessRegistry, ToolRegistryImpl};
use celestea_workers::{worker_tools_with, WorkerRegistry};

/// Register every tool the runtime surfaces into a registry: the builtin file
/// tools (incl. process_control / http_request, W242) plus the
/// worker-orchestration tools, all bound to the shared [WorkerRegistry] and
/// the shared session-scoped [ProcessRegistry]. Used by both
/// [crate::Runtime::compose] (the real agent tool face) and any frontend
/// listing the tool surface, so the two can never drift.
pub fn register_all_tools(
    registry: &mut ToolRegistryImpl,
    workers: Arc<WorkerRegistry>,
    processes: Arc<ProcessRegistry>,
) {
    for tool in builtin_tools_with(processes) {
        registry.register(tool);
    }
    for tool in worker_tools_with(workers) {
        registry.register(tool);
    }
    // W249 P0-3: mount the production guard chain (path whitelist) at Runtime
    // assembly so the file tools can no longer reach the host filesystem
    // unmediated (roadmap R3 / P0-C). CELESTEA_TOOL_GUARD=0 skips mounting.
    mount_production_guards(registry);
}

