//! Tool registration (W214): the runtime tool face — builtin file tools plus
//! the three worker-orchestration tools, bound to the shared [WorkerRegistry].

use std::sync::Arc;

use celestea_core::{SessionEvent, SessionLog, ToolRegistry};
use celestea_tools::{
    builtin_tools_with, mount_production_guards, run_code_tool_with_handle, ProcessRegistry,
    RunCodeConfig, ToolRegistryImpl,
};
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

/// W255 run_code: compose the full runtime tool face — everything
/// [register_all_tools] mounts PLUS the `run_code` tool (Python parent-broker).
///
/// The registry is wrapped in an `Arc` first, then run_code is registered
/// holding a `Weak` handle back to it, so its sub-calls dispatch through the
/// exact same guard chain + tools (zero duplicated pipeline) and its sub-call
/// ToolCall/ToolResult events (id "<parent>:c<n>", parent_id) land in the
/// session log. The `Weak` never raises the strong count, so the second
/// `Arc::get_mut` still sees the sole owner.
pub fn build_registry(
    workers: Arc<WorkerRegistry>,
    processes: Arc<ProcessRegistry>,
    session: Arc<dyn SessionLog>,
) -> Arc<dyn ToolRegistry> {
    let mut registry = Arc::new(ToolRegistryImpl::new());
    register_all_tools(
        Arc::get_mut(&mut registry).expect("sole registry owner before share"),
        workers,
        processes,
    );
    let events: Arc<dyn Fn(SessionEvent) + Send + Sync> = Arc::new({
        let session = session.clone();
        move |ev| session.append(ev)
    });
    // W255 run_code: registered while the Arc is still uniquely owned (a live
    // Weak would defeat Arc::get_mut), then bound to the registry through its
    // RegistryHandle — sub-calls dispatch through the identical pipeline.
    let (tool, handle) = run_code_tool_with_handle(RunCodeConfig::from_env(), Some(events));
    Arc::get_mut(&mut registry)
        .expect("sole registry owner before share")
        .register(tool);
    let weak: std::sync::Weak<dyn ToolRegistry> = {
        let dyn_clone: Arc<dyn ToolRegistry> = registry.clone();
        Arc::downgrade(&dyn_clone)
    };
    handle.set(weak);
    registry
}

