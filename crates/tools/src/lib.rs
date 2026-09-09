//! # celestea-tools
//!
//! Tool registry + guarded dispatch pipeline + builtin filesystem/shell tools
//! (W103). Implements `celestea_core::ToolRegistry` over a name-keyed map of
//! `Arc<dyn Tool>` and an ordered list of `Arc<dyn ToolGuard>`.
//!
//! Split into five modules by responsibility:
//! - [`registry`]: `ToolRegistryImpl` + the `ToolRegistry` impl;
//! - [`builtin`]: `builtin_tools`, the `FnTool` seam, the hand-written JSON
//!   schemas and the `run_shell` tool wired to the v1 sandbox;
//! - [`sandbox`]: the userspace v1 execution sandbox for `run_shell` (W209);
//! - [`process`]: the W242 session-scoped background process registry +
//!   `process_control` tool;
//! - [`http`]: the W242 `http_request` builtin tool.

pub mod builtin;
mod guard;
mod http;
mod process;
mod registry;
mod sandbox;

pub use crate::builtin::{builtin_tools, builtin_tools_with};
pub use crate::guard::{mount_production_guards, parse_roots, PathGuard, PathGuardPolicy};
pub use crate::process::{
    ChildHandle, ProcessCompletion, ProcessRegistry, ProcessRegistryService,
};
pub use crate::registry::ToolRegistryImpl;

// Internal re-exports consumed by `mod tests` (super::*) within this crate.
#[cfg(test)]
pub(crate) use crate::builtin::{
    fn_tool, human_render, read_file_spec, run_shell_spec, run_shell_tool, run_shell_tool_with,
};
#[cfg(test)]
pub(crate) use crate::http::{http_request_tool_with, HttpTargetPolicy};
#[cfg(test)]
pub(crate) use crate::process::process_control_tool;
#[cfg(test)]
pub(crate) use crate::sandbox::SandboxConfig;

#[cfg(test)]
use async_trait::async_trait;
// Types referenced by the test module under `super::*`.
#[cfg(test)]
use celestea_core::{ToolDecision, ToolGuard, ToolInput, ToolRegistry};
#[cfg(test)]
use serde_json::{json, Value};
#[cfg(test)]
use std::sync::Arc;

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
        assert_eq!(
            names,
            vec![
                "http_request",
                "list_dir",
                "process_control",
                "read_file",
                "run_shell",
                "write_file"
            ]
        );
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

    // ---- W209: run_shell v1 sandbox (dispatch-level contract) --------------

    #[tokio::test]
    async fn run_shell_timeout_violation_is_structured_tool_error() {
        let mut registry = ToolRegistryImpl::new();
        let cfg = SandboxConfig::new()
            .with_workdir(std::env::temp_dir())
            .with_root(std::env::temp_dir())
            .with_timeout(std::time::Duration::from_millis(200));
        registry.register(run_shell_tool(cfg));
        // Fork-health probe (W249): under host-wide RLIMIT_NPROC exhaustion
        // `sh` cannot fork and exits before the timeout kill — skip instead
        // of failing on an environmental condition.
        let health = registry
            .dispatch(sample_input("c-health", "run_shell", json!({ "command": "sleep 0.01" })))
            .await;
        if health.value.as_ref().and_then(|v| v["exit_code"].as_i64()) != Some(0) {
            eprintln!("skip: cannot fork a sandbox child right now (host nproc budget)");
            return;
        }
        let out = registry
            .dispatch(sample_input("c-timeout", "run_shell", json!({ "command": "sleep 5" })))
            .await;
        assert_eq!(out.value, None);
        assert_eq!(out.render, None);
        let err = out.error.expect("structured timeout error");
        assert!(err.starts_with("run_shell-sandbox: code=timeout"), "{err}");
        // ToolOutput decision/render contract unchanged for violations.
        assert_eq!(out.decision, Some(ToolDecision::Allow));
    }

    #[tokio::test]
    async fn run_shell_workdir_violation_is_structured_tool_error() {
        let root =
            std::env::temp_dir().join(format!("celestea-dispatch-wd-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("celestea-dispatch-out-{}", std::process::id()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let mut registry = ToolRegistryImpl::new();
        let cfg = SandboxConfig::new()
            .with_workdir(&root)
            .with_root(&root)
            .with_timeout(std::time::Duration::from_secs(5));
        registry.register(run_shell_tool(cfg));
        let out = registry
            .dispatch(sample_input(
                "c-wd",
                "run_shell",
                json!({ "command": "pwd", "workdir": outside.to_string_lossy() }),
            ))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("structured workdir error");
        assert!(err.starts_with("run_shell-sandbox: code=workdir"), "{err}");
        assert!(err.contains("outside the sandbox root"), "{err}");
        assert_eq!(out.decision, Some(ToolDecision::Allow));
    }

    #[tokio::test]
    async fn run_shell_success_reports_sandbox_metadata() {
        let mut registry = ToolRegistryImpl::new();
        let cfg = SandboxConfig::new()
            .with_workdir(std::env::temp_dir())
            .with_root(std::env::temp_dir())
            .with_timeout(std::time::Duration::from_secs(5));
        registry.register(run_shell_tool(cfg));
        let out = registry
            .dispatch(sample_input("c-sbox", "run_shell", json!({ "command": "printf hi" })))
            .await;
        let value = out.value.expect("value");
        assert_eq!(value["exit_code"], json!(0));
        assert_eq!(value["stdout"], json!("hi"));
        assert_eq!(value["stdout_truncated"], json!(false));
        assert_eq!(value["stderr_truncated"], json!(false));
        assert_eq!(out.error, None);
    }

    // ---- W242: background processes + process_control + http_request --------------

    async fn wait_until_async<F: FnMut() -> bool>(mut cond: F, max_ms: u64) {
        for _ in 0..(max_ms / 10) {
            if cond() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("condition not met within {max_ms} ms");
    }

    fn bg_registry(dir: &std::path::Path) -> (ToolRegistryImpl, Arc<ProcessRegistry>) {
        let processes = Arc::new(ProcessRegistry::new());
        let cfg = SandboxConfig::new()
            .with_workdir(dir)
            .with_root(dir)
            .with_timeout(std::time::Duration::from_secs(5));
        let mut registry = ToolRegistryImpl::new();
        registry.register(run_shell_tool_with(cfg, processes.clone()));
        registry.register(process_control_tool(processes.clone()));
        (registry, processes)
    }

    /// A: background spawn -> poll running -> stdin line -> kill -> self-removal.
    #[tokio::test]
    async fn run_shell_background_spawn_poll_stdin_kill() {
        let dir = std::env::temp_dir().join(format!("celestea-bg-flow-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let (registry, processes) = bg_registry(&dir);

        let out = registry
            .dispatch(sample_input("bg1", "run_shell", json!({
                "command": "while IFS= read -r l; do echo \"got:$l\"; done",
                "background": true
            })))
            .await;
        assert!(out.error.is_none(), "background spawn error: {:?}", out.error);
        let value = out.value.expect("background spawn value");
        assert_eq!(value["background"], json!(true));
        let handle = value["handle"].as_str().expect("handle").to_string();
        assert!(value["pid"].as_u64().unwrap_or(0) > 0, "pid must be positive: {value}");

        // poll -> running
        let poll = registry
            .dispatch(sample_input("bg2", "process_control", json!({ "handle": handle, "action": "poll" })))
            .await;
        assert!(poll.error.is_none(), "poll error: {:?}", poll.error);
        let poll_v = poll.value.as_ref().unwrap();
        assert_eq!(poll_v["running"], json!(true), "poll: {poll_v}");

        // stdin -> one line + newline
        let w = registry
            .dispatch(sample_input("bg3", "process_control", json!({ "handle": handle, "action": "stdin", "content": "hello" })))
            .await;
        assert!(w.error.is_none(), "stdin error: {:?}", w.error);
        let wv = w.value.as_ref().unwrap();
        assert!(wv["written"].as_u64().unwrap_or(0) >= 6, "stdin write: {wv}");

        // poll until the echoed line lands in stdout_tail
        let mut tail = String::new();
        for _ in 0..300 {
            let p = registry
                .dispatch(sample_input("bg4", "process_control", json!({ "handle": handle, "action": "poll" })))
                .await;
            tail = p.value.as_ref().unwrap()["stdout_tail"].as_str().unwrap_or("").to_string();
            if tail.contains("got:hello") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(tail.contains("got:hello"), "stdout_tail must contain the echoed line: {tail}");

        // kill -> killed:true
        let k = registry
            .dispatch(sample_input("bg5", "process_control", json!({ "handle": handle, "action": "kill" })))
            .await;
        assert!(k.error.is_none(), "kill error: {:?}", k.error);
        assert_eq!(k.value.as_ref().unwrap()["killed"], json!(true), "kill: {}", k.value.as_ref().unwrap());

        // exited process self-removes from the registry
        wait_until_async(|| processes.len() == 0, 5000).await;

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// A: a finished background process is reaped and removed automatically.
    #[tokio::test]
    async fn background_process_self_removes_on_exit() {
        let dir = std::env::temp_dir().join(format!("celestea-bg-exit-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let (registry, processes) = bg_registry(&dir);

        let out = registry
            .dispatch(sample_input("bx1", "run_shell", json!({ "command": "sleep 0.2; exit 7", "background": true })))
            .await;
        assert!(out.error.is_none(), "spawn error: {:?}", out.error);
        let value = out.value.expect("value");
        let handle = value["handle"].as_str().expect("handle").to_string();

        // reaper removes the entry as soon as the process exits
        wait_until_async(|| processes.len() == 0, 5000).await;

        // poll on a removed handle -> unknown handle contract error
        let poll = registry
            .dispatch(sample_input("bx2", "process_control", json!({ "handle": handle, "action": "poll" })))
            .await;
        assert!(poll.error.is_none(), "contract errors are values, not tool errors: {:?}", poll.error);
        let v = poll.value.expect("contract value");
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("unknown handle"), "{v}");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// A: process_control contract errors are structured {ok:false} values.
    #[tokio::test]
    async fn process_control_validates_handle_and_action() {
        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }
        let out = registry
            .dispatch(sample_input("pc1", "process_control", json!({ "handle": "nope", "action": "poll" })))
            .await;
        let v = out.value.expect("contract value");
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("unknown handle"), "{v}");

        let out = registry
            .dispatch(sample_input("pc2", "process_control", json!({ "handle": "nope", "action": "dance" })))
            .await;
        let v = out.value.expect("contract value");
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("unknown action"), "{v}");

        let out = registry
            .dispatch(sample_input("pc3", "process_control", json!({ "action": "poll" })))
            .await;
        let v = out.value.expect("contract value");
        assert_eq!(v["ok"], json!(false));
    }

    // ---- B: run_shell spec documents the timeout cap + background mode ------------

    #[test]
    fn run_shell_spec_documents_timeout_cap_and_background() {
        let spec = run_shell_spec();
        let desc = &spec.description;
        assert!(desc.contains("CELESTEA_SHELL_MAX_TIMEOUT_MS"), "{desc}");
        assert!(desc.contains("process_control"), "{desc}");
        assert!(desc.contains("background"), "{desc}");

        let props = &spec.parameters["properties"];
        let t = props["timeout_ms"]["description"].as_str().expect("timeout_ms description");
        assert!(t.contains("CELESTEA_SHELL_MAX_TIMEOUT_MS"), "{t}");
        assert!(t.contains("30000"), "{t}");
        assert!(t.contains("300000"), "{t}");

        let bg = props["background"]["description"].as_str().expect("background param");
        assert!(bg.contains("process_control"), "{bg}");
        assert!(bg.contains("timeout"), "{bg}"); // documents: no call-level timeout
        assert_eq!(props["background"]["type"], json!("boolean"));
        assert_eq!(spec.parameters["required"], json!(["command"]));
    }

    // ---- C: http_request guard / truncation / categorization ----------------------

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot raw HTTP server: reads the request head, replies with `respond`.
    async fn serve_once<F>(respond: F) -> u16
    where
        F: FnOnce(&[u8]) -> Vec<u8> + Send + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = sock.write_all(&respond(&buf)).await;
        });
        port
    }

    /// Server that accepts the request but never responds (timeout test).
    async fn serve_hang() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await; // never respond
        });
        port
    }

    /// Server answering `count` sequential connections with 302 hops.
    async fn serve_redirects(count: u32) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for i in 0..count {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 1024];
                loop {
                    let n = sock.read(&mut tmp).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let resp = format!(
                    "HTTP/1.1 302 Found\r\nLocation: /hop/{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    i + 1
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        port
    }

    /// Server streaming `total` bytes of 'a' after a 200 head.
    async fn serve_big_body(total: usize) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let chunk = vec![b'a'; 65536];
            let mut sent = 0;
            while sent < total {
                let take = (total - sent).min(chunk.len());
                let _ = sock.write_all(&chunk[..take]).await;
                sent += take;
            }
        });
        port
    }

    fn http_registry() -> ToolRegistryImpl {
        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }
        registry
    }

    /// C guard: file:// and friends are rejected before any request goes out.
    #[tokio::test]
    async fn http_request_rejects_non_http_schemes() {
        let registry = http_registry();
        for (i, url) in ["file:///etc/passwd", "ftp://example.com/x", "gopher://x"].iter().enumerate() {
            let out = registry
                .dispatch(sample_input(&format!("h{i}"), "http_request", json!({ "url": url })))
                .await;
            assert_eq!(out.value, None);
            let err = out.error.expect("guard error");
            assert!(err.starts_with("http_request: code=invalid_url"), "url {url}: {err}");
        }
        let out = registry
            .dispatch(sample_input("hrel", "http_request", json!({ "url": "not a url" })))
            .await;
        assert!(out.error.unwrap().starts_with("http_request: code=invalid_url"));

        let out = registry
            .dispatch(sample_input("hm", "http_request", json!({ "url": "http://127.0.0.1:1/", "method": "BREW" })))
            .await;
        assert!(out.error.unwrap().contains("code=invalid_arg"));

        let out = registry
            .dispatch(sample_input("ht", "http_request", json!({ "url": "http://127.0.0.1:1/", "timeout_ms": 999999 })))
            .await;
        assert!(out.error.unwrap().contains("code=invalid_arg"));
    }

    /// C: HTTP error statuses are preserved (not tool errors) and the body is
    /// truncated at 1 MiB with truncated:true.
    #[tokio::test]
    async fn http_request_preserves_status_and_truncates_large_body() {
        let registry = http_registry();
        let port = serve_big_body(1_100_000).await;
        let out = registry
            .dispatch(sample_input("hbig", "http_request", json!({
                "url": format!("http://127.0.0.1:{port}/big"),
                "method": "GET"
            })))
            .await;
        assert!(out.error.is_none(), "http error: {:?}", out.error);
        let v = out.value.expect("value");
        assert_eq!(v["status"], json!(200));
        assert_eq!(v["truncated"], json!(true));
        assert_eq!(v["body"].as_str().unwrap().len(), 1_048_576, "body capped at 1MB");
        assert_eq!(v["headers"]["content-type"], json!("text/plain"));

        let port404 = serve_once(|_req| {
            b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found".to_vec()
        })
        .await;
        let out = registry
            .dispatch(sample_input("h404", "http_request", json!({
                "url": format!("http://127.0.0.1:{port404}/missing")
            })))
            .await;
        assert!(out.error.is_none(), "404 must not be a tool error: {:?}", out.error);
        let v = out.value.expect("value");
        assert_eq!(v["status"], json!(404));
        assert_eq!(v["truncated"], json!(false));
        assert_eq!(v["body"], json!("not found"));
    }

    /// C: a stalled server surfaces as a categorized timeout.
    #[tokio::test]
    async fn http_request_categorizes_timeout() {
        let registry = http_registry();
        let port = serve_hang().await;
        let out = registry
            .dispatch(sample_input("hto", "http_request", json!({
                "url": format!("http://127.0.0.1:{port}/slow"),
                "timeout_ms": 500
            })))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("timeout error");
        assert!(err.starts_with("http_request: code=timeout"), "{err}");
    }

    /// C: an unresolvable hostname surfaces as a categorized dns failure.
    #[tokio::test]
    async fn http_request_categorizes_dns_failure() {
        let registry = http_registry();
        let out = registry
            .dispatch(sample_input("hdns", "http_request", json!({
                "url": "http://no-such-host-celestea.invalid/",
                "timeout_ms": 5000
            })))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("dns error");
        assert!(err.starts_with("http_request: code=dns"), "{err}");
    }

    /// C: redirects are capped at 5 hops -> the 6th hop is a categorized
    /// redirect failure.
    #[tokio::test]
    async fn http_request_caps_redirects_at_five() {
        let registry = http_registry();
        let port = serve_redirects(7).await;
        let out = registry
            .dispatch(sample_input("hredir", "http_request", json!({
                "url": format!("http://127.0.0.1:{port}/hop/0"),
                "timeout_ms": 10000
            })))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("redirect error");
        assert!(err.starts_with("http_request: code=redirect"), "{err}");
    }

    // ---- W249 P0-3: http_request SSRF target policy ---------------------------

    fn http_registry_with_policy(policy: HttpTargetPolicy) -> ToolRegistryImpl {
        let mut registry = ToolRegistryImpl::new();
        registry.register(http_request_tool_with(policy));
        registry
    }

    fn ssrf_ok_response() -> Vec<u8> {
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec()
    }

    /// allow list covering a different subnet -> 127.0.0.1 is refused.
    #[tokio::test]
    async fn ssrf_allow_list_blocks_targets_outside_policy() {
        let port = serve_once(|_req| ssrf_ok_response()).await;
        let registry = http_registry_with_policy(
            HttpTargetPolicy::parse(Some("10.0.0.0/8"), None).unwrap(),
        );
        let out = registry
            .dispatch(sample_input("s1", "http_request", json!({ "url": format!("http://127.0.0.1:{port}/") })))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("policy error");
        assert!(err.starts_with("http_request: code=target_forbidden"), "{err}");
    }

    /// deny list blocks listed targets.
    #[tokio::test]
    async fn ssrf_deny_list_blocks_listed_targets() {
        let port = serve_once(|_req| ssrf_ok_response()).await;
        let registry =
            http_registry_with_policy(HttpTargetPolicy::parse(None, Some("127.0.0.0/8")).unwrap());
        let out = registry
            .dispatch(sample_input("s2", "http_request", json!({ "url": format!("http://127.0.0.1:{port}/") })))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("policy error");
        assert!(err.starts_with("http_request: code=target_forbidden"), "{err}");
    }

    /// allow list admits matching targets.
    #[tokio::test]
    async fn ssrf_allow_list_admits_policy_targets() {
        let port = serve_once(|_req| ssrf_ok_response()).await;
        let registry = http_registry_with_policy(
            HttpTargetPolicy::parse(Some("127.0.0.1/32"), None).unwrap(),
        );
        let out = registry
            .dispatch(sample_input("s3", "http_request", json!({ "url": format!("http://127.0.0.1:{port}/x") })))
            .await;
        assert!(out.error.is_none(), "{:?}", out.error);
        let v = out.value.expect("value");
        assert_eq!(v["status"], json!(200));
        assert_eq!(v["body"], json!("ok"));
    }

    /// with a policy active, redirect hops are re-checked: hop 0 at
    /// 127.0.0.1 answers 302 -> 10.0.0.1 (outside the allow list).
    #[tokio::test]
    async fn ssrf_policy_checks_redirect_hops() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let resp = b"HTTP/1.1 302 Found\r\nLocation: http://10.0.0.1/hop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = sock.write_all(resp).await;
        });
        let registry = http_registry_with_policy(
            HttpTargetPolicy::parse(Some("127.0.0.1/32"), None).unwrap(),
        );
        let out = registry
            .dispatch(sample_input("s4", "http_request", json!({ "url": format!("http://127.0.0.1:{port}/start") })))
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("hop policy error");
        assert!(err.starts_with("http_request: code=target_forbidden"), "{err}");
    }

    /// no policy configured -> allow all (the pre-P0-3 status quo), and the
    /// plain builtin registry still resolves loopback targets.
    #[tokio::test]
    async fn ssrf_default_policy_allows_all_targets() {
        let registry = http_registry_with_policy(HttpTargetPolicy::default());
        let port = serve_once(|_req| ssrf_ok_response()).await;
        let out = registry
            .dispatch(sample_input("s5", "http_request", json!({ "url": format!("http://127.0.0.1:{port}/ok") })))
            .await;
        assert!(out.error.is_none(), "{:?}", out.error);
        assert_eq!(out.value.as_ref().unwrap()["status"], json!(200));
    }
}
