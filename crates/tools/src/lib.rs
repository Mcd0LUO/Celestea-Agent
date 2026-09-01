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
                        error: Some(format!("denied: {reason}")),
                    };
                }
                ToolDecision::Ask(question) => {
                    return ToolOutput {
                        call_id,
                        value: None,
                        error: Some(format!("ask: {question}")),
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
                    error: Some(format!("unknown tool: {}", input.name)),
                };
            }
        };

        match tool.execute(input.args).await {
            Ok(value) => ToolOutput { call_id, value: Some(value), error: None },
            Err(e) => ToolOutput { call_id, value: None, error: Some(e) },
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

    #[tokio::test]
    async fn unknown_tool_reports_error() {
        let registry = ToolRegistryImpl::new();
        let out = registry.dispatch(sample_input("c2", "nope", json!({}))).await;
        assert_eq!(out.value, None);
        assert_eq!(out.error, Some("unknown tool: nope".to_string()));
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
}
