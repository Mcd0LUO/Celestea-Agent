//! # celestea-tools
//!
//! Tool registry + guarded dispatch pipeline + builtin filesystem/shell tools
//! (W103). Implements `celestea_core::ToolRegistry` over a name-keyed map of
//! `Arc<dyn Tool>` and an ordered list of `Arc<dyn ToolGuard>`.
//!
//! Split into two modules by responsibility:
//! - [`registry`]: `ToolRegistryImpl` + the `ToolRegistry` impl;
//! - [`builtin`]: `builtin_tools`, the `FnTool` seam, the hand-written JSON
//!   schemas and the platform shell invocation for `run_shell`.

pub mod builtin;
mod registry;

pub use crate::builtin::builtin_tools;
pub use crate::registry::ToolRegistryImpl;

// Internal re-exports consumed by `mod tests` (super::*) within this crate.
#[cfg(test)]
pub(crate) use crate::builtin::{fn_tool, human_render, read_file_spec};

#[cfg(test)]
use async_trait::async_trait;
// Types referenced by the test module under `super::*`.
#[cfg(test)]
use celestea_core::{ToolDecision, ToolGuard, ToolInput, ToolRegistry};
#[cfg(test)]
use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input(call_id: &str, name: &str, args: Value) -> ToolInput {
        ToolInput { call_id: call_id.into(), name: name.into(), args }
    }

    #[tokio::test]
    async fn read_file_dispatch_reads_temp_file() {
        let dir = std::env::temp_dir().join(format!("celestea-tools-test-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let file = dir.join("sample.txt");
        tokio::fs::write(&file, "hello celestea").await.unwrap();

        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }

        let out = registry
            .dispatch(sample_input("c1", "read_file", json!({ "path": file.to_string_lossy() })))
            .await;

        assert_eq!(out.call_id, "c1");
        assert!(out.error.is_none(), "unexpected error: {:?}", out.error);
        assert_eq!(out.value, Some(json!("hello celestea")));
    }

    // ---- W189: ToolOutput render (canonical value vs human render) ----------

    #[tokio::test]
    async fn read_file_dispatch_render_is_none() {
        let dir = std::env::temp_dir().join(format!("celestea-tools-render-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let file = dir.join("r.txt");
        tokio::fs::write(&file, "plain text").await.unwrap();

        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }
        let out = registry
            .dispatch(sample_input("c-r", "read_file", json!({ "path": file.to_string_lossy() })))
            .await;

        // read_file: the canonical value IS the human-readable text -> render None.
        assert_eq!(out.value, Some(json!("plain text")));
        assert_eq!(out.render, None);
    }
    #[tokio::test]
    async fn run_shell_dispatch_render_summarizes_stream() {
        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }
        let out = registry
            .dispatch(sample_input("c-sh", "run_shell", json!({ "command": "printf hi" })))
            .await;

        // run_shell: canonical value is the structured object, render is the
        // condensed stdout+stderr summary.
        let value = out.value.expect("run_shell value");
        assert_eq!(value["exit_code"], json!(0));
        assert_eq!(value["stdout"], json!("hi"));
        let render = out.render.expect("run_shell render");
        assert!(render.contains("exit_code: 0"), "{render}");
        assert!(render.contains("stdout: hi"), "{render}");
    }

    #[test]
    fn human_render_plain_text_is_none() {
        // read_file / write_file style string values need no separate render.
        assert_eq!(human_render(&json!("plain text")), None);
        assert_eq!(human_render(&json!([])), None);
        assert_eq!(human_render(&json!({ "n": 1 })), None);
    }

    #[test]
    fn human_render_run_shell_shape_summarizes() {
        let v = json!({
            "stdout": "hello",
            "stderr": "",
            "exit_code": 0
        });
        let render = human_render(&v).expect("shell render");
        assert!(render.contains("exit_code: 0"), "{render}");
        assert!(render.contains("stdout: hello"), "{render}");
        assert!(!render.contains("stderr"), "{render}");

        // empty streams but a known exit code -> one-line render
        assert_eq!(
            human_render(&json!({ "stdout": "", "stderr": "", "exit_code": 0 })),
            Some("exit_code: 0".to_string())
        );

        // nothing worth rendering (empty streams + unknown exit code) -> None
        assert_eq!(
            human_render(&json!({ "stdout": "", "stderr": "", "exit_code": null })),
            None
        );
    }

    #[tokio::test]
    async fn unknown_tool_reports_error() {
        let registry = ToolRegistryImpl::new();
        let out = registry.dispatch(sample_input("c2", "nope", json!({}))).await;
        assert_eq!(out.value, None);
        assert_eq!(out.error, Some("unknown tool: nope".to_string()));
        assert_eq!(out.decision, Some(ToolDecision::Allow));
    }

    #[tokio::test]
    async fn guard_deny_short_circuits() {
        struct DenyAll;
        #[async_trait]
        impl ToolGuard for DenyAll {
            async fn check(&self, _input: &ToolInput) -> ToolDecision {
                ToolDecision::Deny("policy says no".into())
            }
        }

        let mut registry = ToolRegistryImpl::new();
        registry.add_guard(Box::new(DenyAll));
        let out = registry.dispatch(sample_input("c3", "read_file", json!({}))).await;
        assert_eq!(out.error, Some("denied: policy says no".to_string()));
        assert_eq!(out.value, None);
        assert_eq!(out.decision, Some(ToolDecision::Deny("policy says no".into())));
    }

    #[tokio::test]
    async fn guard_ask_short_circuits_with_structured_decision() {
        struct AskAll;
        #[async_trait]
        impl ToolGuard for AskAll {
            async fn check(&self, _input: &ToolInput) -> ToolDecision {
                ToolDecision::Ask("confirm overwrite?".into())
            }
        }

        let mut registry = ToolRegistryImpl::new();
        registry.add_guard(Box::new(AskAll));
        let out =
            registry.dispatch(sample_input("c-ask", "write_file", json!({ "path": "x" }))).await;
        assert_eq!(out.error, Some("ask: confirm overwrite?".to_string()));
        assert_eq!(out.value, None);
        assert_eq!(out.decision, Some(ToolDecision::Ask("confirm overwrite?".into())));
    }

    #[tokio::test]
    async fn guard_allow_execution_path_sets_allow_decision() {
        struct AllowAll;
        #[async_trait]
        impl ToolGuard for AllowAll {
            async fn check(&self, _input: &ToolInput) -> ToolDecision {
                ToolDecision::Allow
            }
        }

        let mut registry = ToolRegistryImpl::new();
        registry.add_guard(Box::new(AllowAll));
        for tool in builtin_tools() {
            registry.register(tool);
        }

        // Success path: guards all Allow, tool executes Ok.
        let dir = std::env::temp_dir().join(format!("celestea-tools-allow-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let file = dir.join("a.txt");
        tokio::fs::write(&file, "ok").await.unwrap();
        let out = registry
            .dispatch(sample_input("c-ok", "read_file", json!({ "path": file.to_string_lossy() })))
            .await;
        assert_eq!(out.value, Some(json!("ok")));
        assert_eq!(out.error, None);
        assert_eq!(out.decision, Some(ToolDecision::Allow));

        // Unknown tool after the Allow chain still records Allow (permitted but failed).
        let unk = registry.dispatch(sample_input("c-unk", "nope", json!({}))).await;
        assert_eq!(unk.value, None);
        assert_eq!(unk.error, Some("unknown tool: nope".to_string()));
        assert_eq!(unk.decision, Some(ToolDecision::Allow));
    }

    #[tokio::test]
    async fn schemas_are_sorted_by_name() {
        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }
        let specs = registry.schemas();
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        assert_eq!(names, vec!["list_dir", "read_file", "run_shell", "write_file"]);
    }

    // ---- W188: dispatch 基准 (std::time::Instant, 输出到测试日志) ----------

    #[tokio::test]
    async fn bench_dispatch_throughput() {
        // Dispatch with NO guard and an unknown tool name: exercises the guard
        // loop + registry lookup + ToolOutput construction, i.e. the dispatch
        // pipeline overhead without filesystem/shell IO.
        let mut registry = ToolRegistryImpl::new();
        registry.register(fn_tool(read_file_spec(), |_args| {
            Box::pin(async move { Ok(json!("ok")) })
        }));
        let _input = sample_input("c1", "no_such_tool", json!({ "path": "x" }));

        // Warm up.
        for _ in 0..100 {
            let _ = registry.dispatch(sample_input("w", "no_such_tool", json!({}))).await;
        }

        const ITERS: usize = 20_000;
        let t0 = std::time::Instant::now();
        for i in 0..ITERS {
            let out = registry.dispatch(sample_input("c1", "no_such_tool", json!({}))).await;
            assert!(out.error.is_some(), "unknown tool must error at iter {i}");
        }
        let dur = t0.elapsed();
        let per_sec = (ITERS as f64 / dur.as_secs_f64()).round();
        eprintln!("[bench] dispatch(pipeline, miss path): iters={ITERS} {:?} -> {per_sec}/s", dur);
        assert!(dur.as_secs_f64() < 30.0, "benchmark must not stall the suite");
    }
}
