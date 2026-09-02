//! # celestea-tools
//!
//! Tool registry + guarded dispatch pipeline + builtin filesystem/shell tools
//! (W103). Implements `celestea_core::ToolRegistry` over a name-keyed map of
//! `Arc<dyn Tool>` and an ordered list of `Arc<dyn ToolGuard>`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use celestea_core::{Tool, ToolDecision, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolSpec};
use serde_json::{json, Value};

// ============================================================================
// 1. The registry
// ============================================================================

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

// ============================================================================
// 2. Builtin tools
// ============================================================================

/// The four MVP builtin tools: read_file, write_file, list_dir, run_shell.
pub fn builtin_tools() -> Vec<Box<dyn Tool>> {
    vec![
        fn_tool(read_file_spec(), |args| {
            Box::pin(async move {
                let path = arg_str(&args, "path")?.to_owned();
                tokio::fs::read_to_string(&path)
                    .await
                    .map(Value::String)
                    .map_err(|e| e.to_string())
            })
        }),
        fn_tool(write_file_spec(), |args| {
            Box::pin(async move {
                let path = arg_str(&args, "path")?.to_owned();
                let content = arg_str(&args, "content")?.to_owned();
                tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
                Ok(json!("ok"))
            })
        }),
        fn_tool(list_dir_spec(), |args| {
            Box::pin(async move {
                let path = arg_str(&args, "path")?.to_owned();
                let mut dir = tokio::fs::read_dir(&path).await.map_err(|e| e.to_string())?;
                let mut names = Vec::new();
                while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
                    names.push(Value::String(entry.file_name().to_string_lossy().into_owned()));
                }
                Ok(Value::Array(names))
            })
        }),
        fn_tool(run_shell_spec(), |args| {
            Box::pin(async move {
                let command = arg_str(&args, "command")?.to_owned();
                let output = shell_command(&command).output().await.map_err(|e| e.to_string())?;
                Ok(json!({
                    "stdout": String::from_utf8_lossy(&output.stdout).into_owned(),
                    "stderr": String::from_utf8_lossy(&output.stderr).into_owned(),
                    "exit_code": output.status.code(),
                }))
            })
        }),
    ]
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing '{key}' (expected string)"))
}

/// Best-effort human-readable rendering of a successful tool result for the
/// ToolOutput::render field (W189). The canonical value stays authoritative;
/// render only improves the human/UI view:
/// - run_shell ({stdout, stderr, exit_code}) -> condensed stream summary;
/// - read_file (plain text) and everything else -> None (the value is already
///   human-readable, or a compact JSON view is adequate).
fn human_render(value: &Value) -> Option<String> {
    if let Some(obj) = value.as_object() {
        if obj.contains_key("stdout") || obj.contains_key("stderr") || obj.contains_key("exit_code") {
            let mut out = String::new();
            if let Some(code) = obj.get("exit_code").filter(|c| !c.is_null()) {
                out.push_str(&format!("exit_code: {code}\n"));
            }
            if let Some(s) = obj.get("stdout").and_then(Value::as_str) {
                if !s.is_empty() {
                    out.push_str(&format!("stdout: {s}\n"));
                }
            }
            if let Some(e) = obj.get("stderr").and_then(Value::as_str) {
                if !e.is_empty() {
                    out.push_str(&format!("stderr: {e}"));
                }
            }
            let out = out.trim_end().to_string();
            return if out.is_empty() { None } else { Some(out) };
        }
    }
    None
}

/// A `Tool` whose behavior is a boxed async closure. Keeps the builtin
/// definitions terse while still satisfying the `Tool` seam exactly.
struct FnTool {
    spec: ToolSpec,
    exec: Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>,
}

fn fn_tool(
    spec: ToolSpec,
    exec: impl Fn(Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync + 'static,
) -> Box<dyn Tool> {
    Box::new(FnTool { spec, exec: Arc::new(exec) })
}

#[async_trait]
impl Tool for FnTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        (self.exec)(args).await
    }
}

/// Build the platform shell invocation for run_shell.
#[cfg(windows)]
fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.args(["/C", command]);
    cmd
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.args(["-c", command]);
    cmd
}

// --- JSON schemas (hand-written, stable argument contracts) ---

fn read_file_spec() -> ToolSpec {
    ToolSpec {
        name: "read_file".into(),
        description: "Read a UTF-8 text file and return its contents as a string.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Filesystem path of the file to read." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    }
}

fn write_file_spec() -> ToolSpec {
    ToolSpec {
        name: "write_file".into(),
        description: "Write text content to a file, creating or overwriting it.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Filesystem path of the file to write." },
                "content": { "type": "string", "description": "Text content to write." }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
    }
}

fn list_dir_spec() -> ToolSpec {
    ToolSpec {
        name: "list_dir".into(),
        description: "List the entry names in a directory.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path to list." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    }
}

fn run_shell_spec() -> ToolSpec {
    ToolSpec {
        name: "run_shell".into(),
        description: "Run a shell command and return its stdout, stderr, and exit code.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The command line to execute." }
            },
            "required": ["command"],
            "additionalProperties": false
        }),
    }
}

// ============================================================================
// 3. Tests
// ============================================================================

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
