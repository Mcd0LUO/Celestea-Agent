//! W255 P0 end-to-end acceptance (the "真实端到端演示" of the eval):
//! a real `run_code` dispatch over the REAL builtin tool registry — the
//! program calls `tools.read_file` through the parent broker, returns the
//! first line, and the session-log sink records the nested sub-call events
//! with the correct composite ids and parent_id.

use std::sync::{Arc, Mutex};

use celestea_core::{
    SessionEvent, ToolInput, ToolRegistry,
};
use celestea_tools::{
    builtin_tools, run_code_tool_with_handle, RunCodeConfig, ToolRegistryImpl,
};

fn tmp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("celestea-run-code-e2e-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create test dir");
    dir
}

#[tokio::test]
async fn run_code_reads_first_line_through_the_real_registry() {
    let dir = tmp_dir("first-line");
    let file = dir.join("notes.txt");
    std::fs::write(&file, "hello-first\nsecond line\n").expect("seed file");

    // The production wiring: registry (real builtins) -> Arc -> run_code via a
    // Weak handle, sub-call events into an in-test log sink.
    let cfg = RunCodeConfig::new()
        .with_workdir(&dir)
        .with_root(&dir)
        .with_timeout(std::time::Duration::from_secs(30));
    let events: Arc<Mutex<Vec<SessionEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: Arc<dyn Fn(SessionEvent) + Send + Sync> = {
        let events = events.clone();
        Arc::new(move |ev| events.lock().unwrap().push(ev))
    };

    let mut reg = ToolRegistryImpl::new();
    for tool in builtin_tools() {
        reg.register(tool);
    }
    let mut reg = Arc::new(reg);
    let (tool, handle) = run_code_tool_with_handle(cfg, Some(sink));
    Arc::get_mut(&mut reg)
        .expect("sole owner")
        .register(tool);
    let weak = {
        let dyn_clone: Arc<dyn ToolRegistry> = reg.clone();
        Arc::downgrade(&dyn_clone)
    };
    handle.set(weak);

    // Python-string-quote the path via JSON so it is always a valid literal.
    let code = format!(
        "async def main():\n    text = tools.read_file(path={})\n    return text.splitlines()[0]\n",
        serde_json::to_string(&file.display().to_string()).unwrap()
    );

    let out = reg
        .dispatch(ToolInput {
            call_id: "rc-e2e".into(),
            name: "run_code".into(),
            args: serde_json::json!({ "code": code, "description": "read first line of notes.txt" }),
        })
        .await;

    assert!(out.error.is_none(), "run_code failed: {:?}", out.error);
    assert_eq!(
        out.value,
        Some(serde_json::json!("hello-first")),
        "final value must be the first line (render: {:?})",
        out.render
    );
    assert_eq!(out.decision, Some(celestea_core::ToolDecision::Allow));

    // Nested sub-call events: composite id "<parent>:c<n>", parent_id set.
    let evs = events.lock().unwrap();
    assert_eq!(evs.len(), 2, "one sub-call pair: {evs:?}");
    match &evs[0] {
        SessionEvent::ToolCall { id, name, args, parent_id } => {
            assert_eq!(id, "rc-e2e:c1");
            assert_eq!(name, "read_file");
            assert_eq!(args["path"], serde_json::json!(file.display().to_string()));
            assert_eq!(parent_id.as_deref(), Some("rc-e2e"));
        }
        other => panic!("expected sub-call ToolCall, got {other:?}"),
    }
    match &evs[1] {
        SessionEvent::ToolResult { id, value, error, parent_id } => {
            assert_eq!(id, "rc-e2e:c1");
            assert_eq!(value, &Some(serde_json::json!("hello-first\nsecond line\n")));
            assert_eq!(error, &None);
            assert_eq!(parent_id.as_deref(), Some("rc-e2e"));
        }
        other => panic!("expected sub-call ToolResult, got {other:?}"),
    }

    // The run_code schema is on the real tool face (the model can call it).
    let names: Vec<String> = reg.schemas().into_iter().map(|s| s.name).collect();
    assert!(names.contains(&"run_code".to_string()), "run_code missing from {names:?}");

    let _ = std::fs::remove_dir_all(&dir);
}
