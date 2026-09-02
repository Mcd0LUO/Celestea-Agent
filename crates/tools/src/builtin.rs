//! Builtin filesystem/shell tools (W103): `builtin_tools`, the `FnTool` seam
//! and the hand-written JSON schemas consumed by the registry.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use celestea_core::{Tool, ToolSpec};
use serde_json::{json, Value};

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
pub(crate) fn human_render(value: &Value) -> Option<String> {
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

pub(crate) fn fn_tool(
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

pub(crate) fn read_file_spec() -> ToolSpec {
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
