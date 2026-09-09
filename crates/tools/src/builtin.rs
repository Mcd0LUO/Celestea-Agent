//! Builtin filesystem/shell tools (W103): `builtin_tools`, the `FnTool` seam
//! and the hand-written JSON schemas consumed by the registry.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use celestea_core::{Tool, ToolSpec};
use serde_json::{json, Value};

use crate::http::http_request_tool;
use crate::process::{process_control_tool, ProcessRegistry};
use crate::sandbox::SandboxConfig;

/// The six builtin tools: read_file, write_file, list_dir, run_shell,
/// process_control, http_request (W242 adds the last two). Each call creates a
/// fresh process registry shared by run_shell / process_control within this
/// tool set; embeddings that mount several tool sets should use
/// [builtin_tools_with] to share one registry.
pub fn builtin_tools() -> Vec<Box<dyn Tool>> {
    builtin_tools_with(Arc::new(ProcessRegistry::new()))
}

/// [builtin_tools] bound to a caller-provided [ProcessRegistry] — the runtime
/// compose mounts one session-scoped registry into the Context and passes it
/// here, so background processes survive across turns and outlive any single
/// tool call.
pub fn builtin_tools_with(processes: Arc<ProcessRegistry>) -> Vec<Box<dyn Tool>> {
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
        run_shell_tool_with(SandboxConfig::from_env(), processes.clone()),
        process_control_tool(processes),
        http_request_tool(),
    ]
}

pub(crate) fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
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

/// `run_shell` tool instance wired to the v1 execution sandbox (W209).
///
/// Default builtins use `SandboxConfig::from_env()` so operators can tune
/// timeouts / output caps / workdir via `CELAESTEA_RUN_SHELL_*` env vars;
/// tests and embeddings may build a `SandboxConfig` directly.
#[cfg(test)] // test-facing convenience; production paths use run_shell_tool_with
pub(crate) fn run_shell_tool(config: SandboxConfig) -> Box<dyn Tool> {
    run_shell_tool_with(config, Arc::new(ProcessRegistry::new()))
}

/// [run_shell_tool] bound to a shared [ProcessRegistry] so `background: true`
/// spawns stay controllable via process_control across turns.
pub(crate) fn run_shell_tool_with(config: SandboxConfig, processes: Arc<ProcessRegistry>) -> Box<dyn Tool> {
    fn_tool(run_shell_spec(), move |args| {
        let config = Arc::new(config.clone());
        let processes = processes.clone();
        Box::pin(async move {
            let command = arg_str(&args, "command")?.to_owned();
            let workdir = args.get("workdir").and_then(Value::as_str);
            let background = args.get("background").and_then(Value::as_bool).unwrap_or(false);
            // W251: completion message on natural exit (default true; false
            // opts this spawn out of the registry's completion sink).
            let notify = args.get("notify").and_then(Value::as_bool).unwrap_or(true);

            // W242 A: background spawn — detached child in the sandbox, no
            // call-level timeout (rlimits still apply), registered in the
            // session process registry and controlled via process_control.
            if background {
                let spawned = crate::sandbox::spawn_sandboxed(&command, &config, workdir)
                    .await
                    .map_err(|e| e.to_string())?;
                let h = processes.insert(spawned.child, spawned.stdin, spawned.stdout, spawned.stderr, notify);
                return Ok(json!({
                    "background": true,
                    "handle": h.handle,
                    "pid": h.pid,
                    // W249 P0-3: the effective sandbox mode is visible, never inferred.
                    "sandbox": spawned.sandbox.as_json(),
                }));
            }

            let timeout_ms = args.get("timeout_ms").and_then(Value::as_i64);
            let out = crate::sandbox::execute_sandboxed(&command, &config, workdir, timeout_ms)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "stdout": String::from_utf8_lossy(&out.stdout).into_owned(),
                "stderr": String::from_utf8_lossy(&out.stderr).into_owned(),
                "exit_code": out.exit_code,
                "stdout_truncated": out.stdout_truncated,
                "stderr_truncated": out.stderr_truncated,
                // W249 P0-3: the effective sandbox mode is visible, never inferred.
                "sandbox": out.sandbox.as_json(),
            }))
        })
    })
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

pub(crate) fn run_shell_spec() -> ToolSpec {
    ToolSpec {
        name: "run_shell".into(),
        description: "Run a shell command inside the sandbox (v2 OS isolation when available: namespaces + read-only root + resource limits, else the v1 userspace path; fixed workdir, sanitized env, bounded timeout and output) and return stdout, stderr, exit code, and a `sandbox` object {provider: bwrap|raw|userspace, net_isolated, tmp_private, seccomp} reporting the effective isolation (W249: network isolated and /tmp a private tmpfs by default; CELESTEA_SANDBOX_NET=1 / CELESTEA_SANDBOX_SHARE_TMP=1 restore the shared host net/tmp; CELESTEA_SANDBOX_SECCOMP=1 enables the seccomp whitelist). With background:true the command is spawned detached (no call-level timeout; resource limits still apply) and returns {background, handle, pid} immediately — control it with the process_control tool (poll / stdin / kill); background processes live in the session process registry and survive across turns. Default timeout is 30s; raise it with timeout_ms up to the cap configured by CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000ms).".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The command line to execute." },
                "workdir": { "type": "string", "description": "Optional working directory. Must already exist inside the sandbox root; relative paths resolve against the sandbox workdir." },
                "timeout_ms": { "type": "integer", "minimum": 1, "description": "Optional per-call timeout in milliseconds. Default 30000; can be raised up to the cap from CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000). Ignored when background:true." },
                "background": { "type": "boolean", "description": "Optional, default false. When true, spawn the command detached (no call-level timeout; rlimits still apply) and return {background:true, handle, pid} immediately; control the process with process_control (poll / stdin / kill). On natural exit the system pushes a completion message into the session mailbox (notify:false turns that off)." },
                "notify": { "type": "boolean", "description": "Optional, default true. When background:true and the process exits naturally, the system posts a '[process] <handle> exited code=<n>' completion message (with stdout/stderr tails) to the session mailbox so the agent is re-engaged automatically; set false to suppress that message (poll via process_control instead)." }
            },
            "required": ["command"],
            "additionalProperties": false
        }),
    }
}
