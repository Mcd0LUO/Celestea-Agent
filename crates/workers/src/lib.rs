//! celestea-workers — harness 内置编排能力（W185）。
//!
//! 按 W180 设计 B1/B2/B3 落地的三个内置工具 + 插件挂载：
//!
//! - [spawn_worker]：在 harness 进程内拉起一个 worker 会话（SessionRegistry::create →
//!   命名 <wid>·<短名> → 可选 tokio 后台驱动 AgentLoop → 写 harness 侧 registry.tsv）。
//! - [session_send_message]：SessionRegistry::resolve（id 直取 / 命名唯一 / 多命中候选）→
//!   SessionMailbox::send 入队。
//! - [worker_status]：读 registry.tsv 返回 RUNNING/DONE/FAILED 汇总（可选按 wid 过滤）。
//!
//! [WorkersPlugin] 在 mount 时 provide 一个含 builtin + 三内置工具的组合
//! [ToolRegistryService]，并把 [WorkerRegistry]（registry.tsv 读写 + SessionRegistry/
//! SessionMailbox 引用 + 驱动 seam）以 [WorkerRegistryService] 提供进 Context。
//!
//! 语义完全在 harness 进程内自洽，不触发 dsh、不 shell-out、不搬 dsh TS 源码；
//! dsh 的 spawn/session-bridge/watchdog 仅作状态机与协议参照。

// ============================================================================
// 模块拆分（W202）：按职责拆成 types / registry / tools / plugin 子模块，watchdog 独立。
// ============================================================================

mod types;
mod registry;
mod tools;
mod plugin;
mod watchdog;

pub use types::{WorkerStatus, WorkerEntry, format_utc};
pub(crate) use types::utc_now;
pub(crate) use crate::tools::sanitize_extra;
pub use registry::{WorkerRegistry, WorkerRegistryService};
pub use tools::{worker_tools, worker_tools_with};
pub use plugin::{WorkersPlugin, WatchdogPlugin};
pub use watchdog::{has_deliverable, session_alive, in_grace, parse_utc, WatchAction, Watchdog, WatchdogConfig};

// 6. 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use celestea_agent_loop::DefaultAgentLoop;
    use celestea_core::{
        AgentConfig, Llm, LlmError, LlmStream, Message, ModelRequest, LlmService, SessionEvent, SessionLog,
        StreamEvent, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolRegistryService, ToolSpec, AgentLoop, Tool,
    };
    use futures_util::stream;
    use async_trait::async_trait;
    use celestea_session::SessionSpec;
    use futures_util::StreamExt;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// 每个测试独立的临时 registry 路径（避免并行测试互踩）。
    fn temp_tsv(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("celestea-workers-{tag}-{}.tsv", std::process::id()))
    }

    fn tool_by_name<'a>(tools: &'a [Box<dyn Tool>], name: &'a str) -> &'a dyn Tool {
        tools.iter().find(|t| t.spec().name == name).map(|t| t.as_ref()).expect("tool present")
    }

    // ---- ToolSpec 形状 ------------------------------------------------------

    #[test]
    fn three_tool_specs_shape() {
        let tools = worker_tools();
        assert_eq!(tools.len(), 3);
        let names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
        assert!(names.iter().any(|n| n.as_str() == "spawn_worker"));
        assert!(names.iter().any(|n| n.as_str() == "session_send_message"));
        assert!(names.iter().any(|n| n.as_str() == "worker_status"));

        let spawn = tool_by_name(&tools, "spawn_worker").spec();
        assert_eq!(spawn.parameters["type"], "object");
        assert_eq!(spawn.parameters["required"], json!(["wid", "brief"]));
        assert_eq!(spawn.parameters["additionalProperties"], json!(false));

        let send = tool_by_name(&tools, "session_send_message").spec();
        assert_eq!(send.parameters["required"], json!(["target", "content"]));
        assert_eq!(send.parameters["additionalProperties"], json!(false));

        let status = tool_by_name(&tools, "worker_status").spec();
        assert_eq!(status.parameters["required"], json!([]));
        assert_eq!(status.parameters["additionalProperties"], json!(false));
    }

    // ---- spawn_worker -------------------------------------------------------

    #[tokio::test]
    async fn spawn_creates_session_and_registry_entry() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("spawn1")));
        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");

        let out = spawn
            .execute(json!({ "wid": "W101", "brief": "do the thing", "workspace": "/ws/proj" }))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let sid = out["sessionId"].as_str().unwrap().to_string();
        assert!(sid.starts_with("session-"), "sessionId {sid}");
        assert_eq!(out["wid"].as_str().unwrap(), "W101");
        assert!(out["title"].as_str().unwrap().contains("W101·"));
        // 未接驱动 seam → 仅登记不驱动
        assert_eq!(out["driven"], json!(false));

        // registry.tsv 行：RUNNING，extra 带 sess/ws
        let entry = reg.get_entry("W101").expect("registry entry written");
        assert_eq!(entry.status, WorkerStatus::Running);
        assert_eq!(entry.get_extra("sess").as_deref(), Some(sid.as_str()));
        assert_eq!(entry.get_extra("ws").as_deref(), Some("/ws/proj"));

        // SessionRegistry 已登记
        assert!(reg.sessions().get(&sid).is_some());
        assert_eq!(reg.sessions().len(), 1);
    }

    #[tokio::test]
    async fn spawn_rejects_duplicate_wid() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("spawndup")));
        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");

        let first = spawn.execute(json!({ "wid": "W7", "brief": "one" })).await.unwrap();
        assert_eq!(first["ok"], true);

        let dup = spawn.execute(json!({ "wid": "W7", "brief": "two" })).await.unwrap();
        assert_eq!(dup["ok"], json!(false));
        assert_eq!(dup["step"], "validate");
        assert!(dup["error"].as_str().unwrap().contains("already registered"));
    }

    #[tokio::test]
    async fn spawn_validates_missing_wid_or_brief() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("spawnval")));
        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");

        let no_wid = spawn.execute(json!({ "brief": "b" })).await.unwrap();
        assert_eq!(no_wid["ok"], json!(false));
        assert_eq!(no_wid["step"], "validate");

        let no_brief = spawn.execute(json!({ "wid": "W1" })).await.unwrap();
        assert_eq!(no_brief["ok"], json!(false));
        assert_eq!(no_brief["step"], "validate");
    }

    // ---- session_send_message ------------------------------------------------

    #[tokio::test]
    async fn send_resolves_by_id_and_unique_title() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("send1")));
        let id1 = reg.sessions().create(SessionSpec { title: "alpha".into(), ..Default::default() });
        reg.sessions().create(SessionSpec { title: "beta".into(), ..Default::default() });
        let tools = worker_tools_with(reg.clone());
        let send = tool_by_name(&tools, "session_send_message");

        // 按 id 直取
        let by_id = send.execute(json!({ "target": id1, "content": "ping" })).await.unwrap();
        assert_eq!(by_id["ok"], json!(true));
        assert_eq!(by_id["delivered"], json!(true));
        assert_eq!(by_id["target"].as_str().unwrap(), id1);
        assert_eq!(by_id["sourceSession"].as_str().unwrap(), "harness-coordinator");
        assert_eq!(reg.mailbox().pending(&id1), 1);

        // 命名唯一 → 解析到该会话
        let by_name = send.execute(json!({ "target": "beta", "content": "hi" })).await.unwrap();
        assert_eq!(by_name["ok"], json!(true));
        assert_eq!(by_name["target"].as_str().unwrap(), "session-1"); // 第二个创建
        assert_eq!(reg.mailbox().pending_total(), 2);
    }

    #[tokio::test]
    async fn send_ambiguous_title_returns_candidates() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("sendamb")));
        reg.sessions().create(SessionSpec { title: "dup".into(), ..Default::default() });
        reg.sessions().create(SessionSpec { title: "dup".into(), ..Default::default() });
        let tools = worker_tools_with(reg.clone());
        let send = tool_by_name(&tools, "session_send_message");

        let out = send.execute(json!({ "target": "dup", "content": "hi" })).await.unwrap();
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["step"], "resolve");
        let candidates = out["candidates"].as_array().expect("candidates list");
        assert_eq!(candidates.len(), 2);
        assert_eq!(reg.mailbox().pending_total(), 0, "ambiguous must not deliver");
    }

    #[tokio::test]
    async fn send_unknown_target_returns_not_found() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("sendnf")));
        let tools = worker_tools_with(reg.clone());
        let send = tool_by_name(&tools, "session_send_message");

        let out = send.execute(json!({ "target": "ghost", "content": "hi" })).await.unwrap();
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["step"], "resolve");
        assert!(out["error"].as_str().unwrap().contains("no session matches target: ghost"));
    }

    #[tokio::test]
    async fn send_validates_empty_content() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("sendval")));
        let tools = worker_tools_with(reg.clone());
        let send = tool_by_name(&tools, "session_send_message");
        let out = send.execute(json!({ "target": "x", "content": "" })).await.unwrap();
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["step"], "validate");
    }

    // ---- worker_status -------------------------------------------------------

    #[tokio::test]
    async fn worker_status_tool_reports_summary_and_filter() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("wstatus")));
        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        spawn.execute(json!({ "wid": "W1", "brief": "b1" })).await.unwrap();

        let status = tool_by_name(&tools, "worker_status");
        let all = status.execute(json!({})).await.unwrap();
        assert_eq!(all["ok"], json!(true));
        assert_eq!(all["total"], json!(1));
        assert_eq!(all["by_status"]["RUNNING"], json!(1));
        assert_eq!(all["by_status"]["DONE"], json!(0));
        assert_eq!(all["workers"][0]["wid"], json!("W1"));

        let filtered = status.execute(json!({ "wid": "W1" })).await.unwrap();
        assert_eq!(filtered["ok"], json!(true));
        assert_eq!(filtered["worker"]["wid"], json!("W1"));

        let miss = status.execute(json!({ "wid": "W99" })).await.unwrap();
        assert_eq!(miss["ok"], json!(false));
        assert_eq!(miss["step"], "lookup");
    }

    // ---- registry.tsv 原子读写 --------------------------------------------------

    #[test]
    fn registry_write_read_roundtrip_atomic() {
        let path = temp_tsv("atomic");
        let reg = WorkerRegistry::new(&path);
        let entries = vec![
            WorkerEntry {
                wid: "W1".into(),
                started_at: "2026-09-01_11:00:00".into(),
                status: WorkerStatus::Running,
                extra: "sess=s1 ws=/ws".into(),
            },
            WorkerEntry {
                wid: "W2".into(),
                started_at: "2026-09-01_11:01:00".into(),
                status: WorkerStatus::Done,
                extra: "sess=s2".into(),
            },
        ];
        reg.write_entries(&entries).unwrap();
        assert!(path.exists(), "registry file must exist");

        let back = reg.read_entries();
        assert_eq!(back, entries, "write/read roundtrip must be lossless");

        // tmp+rename 原子替换：不残留 tmp 文件
        let dir = path.parent().unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-") && n.contains("celestea-workers-atomic"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {leftovers:?}");
    }

    #[test]
    fn registry_skips_bad_lines() {
        let path = temp_tsv("badlines");
        std::fs::write(
            &path,
            "W1\t2026-09-01_11:00:00\tRUNNING\tsess=s1\ngarbage without tabs\nW2\t2026-09-01_11:01:00\tBOGUS\tx\nW3\t2026-09-01_11:02:00\tFAILED\tok\n",
        )
        .unwrap();
        let reg = WorkerRegistry::new(&path);
        let entries = reg.read_entries();
        assert_eq!(entries.len(), 2, "bad lines must be skipped: {entries:?}");
        assert_eq!(entries[0].wid, "W1");
        assert_eq!(entries[1].wid, "W3");
        assert_eq!(entries[1].status, WorkerStatus::Failed);
    }

    #[test]
    fn registry_upsert_and_summarize() {
        let reg = WorkerRegistry::new(temp_tsv("summ"));
        reg.upsert(WorkerEntry {
            wid: "W1".into(),
            started_at: "t0".into(),
            status: WorkerStatus::Running,
            extra: "sess=s1".into(),
        })
        .unwrap();
        reg.upsert(WorkerEntry {
            wid: "W2".into(),
            started_at: "t0".into(),
            status: WorkerStatus::Done,
            extra: "sess=s2".into(),
        })
        .unwrap();

        // 重复 wid → 替换整行
        reg.upsert(WorkerEntry {
            wid: "W1".into(),
            started_at: "t1".into(),
            status: WorkerStatus::Done,
            extra: "sess=s1b".into(),
        })
        .unwrap();

        let entries = reg.read_entries();
        assert_eq!(entries.len(), 2);
        let w1 = entries.iter().find(|e| e.wid == "W1").unwrap();
        assert_eq!(w1.status, WorkerStatus::Done);
        assert_eq!(w1.get_extra("sess").as_deref(), Some("s1b"));

        let summary = reg.summarize(None);
        assert_eq!(summary["total"], json!(2));
        assert_eq!(summary["by_status"]["DONE"], json!(2));
        assert_eq!(summary["by_status"]["RUNNING"], json!(0));

        let single = reg.summarize(Some("W2"));
        assert_eq!(single["ok"], json!(true));
        assert_eq!(single["worker"]["status"], json!("DONE"));
    }

    #[test]
    fn registry_missing_file_reads_empty() {
        let reg = WorkerRegistry::new(temp_tsv("missing"));
        assert!(reg.read_entries().is_empty());
        let summary = reg.summarize(None);
        assert_eq!(summary["ok"], json!(true));
        assert_eq!(summary["total"], json!(0));
    }

    // ---- 时间戳 ---------------------------------------------------------------

    #[test]
    fn utc_format_known_epochs() {
        assert_eq!(format_utc(0), "1970-01-01_00:00:00");
        assert_eq!(format_utc(86_400), "1970-01-02_00:00:00");
        assert_eq!(format_utc(1_234_567_890), "2009-02-13_23:31:30");
        let now = utc_now();
        assert_eq!(now.len(), 19, "expected YYYY-MM-DD_HH:MM:SS, got {now}");
        assert!(now.starts_with("20"), "now should be 2000s: {now}");
    }

    // ---- 后台驱动 ---------------------------------------------------------------

    struct EmptyRegistry;
    #[async_trait]
    impl ToolRegistry for EmptyRegistry {
        fn register(&mut self, _t: Box<dyn Tool>) {}
        fn add_guard(&mut self, _g: Box<dyn ToolGuard>) {}
        fn get(&self, _n: &str) -> Option<&dyn Tool> {
            None
        }
        fn schemas(&self) -> Vec<ToolSpec> {
            Vec::new()
        }
        async fn dispatch(&self, input: ToolInput) -> ToolOutput {
            ToolOutput { call_id: input.call_id, value: None, render: None, error: Some("no tools".into()), decision: None }
        }
    }

    struct FakeLlm {
        replies: Mutex<VecDeque<Message>>,
    }
    impl FakeLlm {
        fn new(replies: Vec<Message>) -> Self {
            Self { replies: Mutex::new(replies.into()) }
        }
    }
    #[async_trait]
    impl Llm for FakeLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Message::assistant_text("done"));
            Ok(stream::iter(vec![StreamEvent::Done(reply)]).boxed())
        }
    }

    #[tokio::test]
    async fn spawn_drives_session_when_drivers_attached() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("drive")));
        let llm = LlmService(Arc::new(FakeLlm::new(vec![Message::assistant_text("hi worker")])));
        let tools_svc = ToolRegistryService(Arc::new(EmptyRegistry));
        let agent: Arc<dyn AgentLoop> = Arc::new(DefaultAgentLoop::new(AgentConfig::default()));
        reg.attach_drivers(Some(Arc::new(llm)), Some(Arc::new(tools_svc)), Some(agent));
        assert!(reg.can_drive());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn
            .execute(json!({ "wid": "WDRV", "brief": "drive me" }))
            .await
            .unwrap();
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["driven"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // 后台 run_turn 会把简报作为 UserMessage 落进该会话 log
        let log = reg.sessions().get(&sid).expect("session registered").log.clone();
        for _ in 0..100 {
            let has = log.events().iter().any(|e| match e {
                SessionEvent::UserMessage { text } => text == "drive me",
                _ => false,
            });
            if has {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("background turn never delivered the brief as a user message");
    }

    // ---- W188: spawn 驱动 seam 压力（后台任务无泄漏） -------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stress_spawn_seam_tasks_are_tracked_and_reaped() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("stress-seam")));
        let llm = LlmService(Arc::new(FakeLlm::new(vec![Message::assistant_text("hi")])));
        let tools_svc = ToolRegistryService(Arc::new(EmptyRegistry));
        let agent: Arc<dyn AgentLoop> = Arc::new(DefaultAgentLoop::new(AgentConfig::default()));
        reg.attach_drivers(Some(Arc::new(llm)), Some(Arc::new(tools_svc)), Some(agent));
        assert!(reg.can_drive());

        // Fire N background turns through the seam.
        const N: usize = 40;
        let mut spawned_sids = Vec::new();
        for i in 0..N {
            let sid = reg.sessions().create(SessionSpec { title: format!("w{i}").into(), ..Default::default() });
            let started = reg.drive_if_possible(&sid, &format!("task {i}")).await;
            assert!(started, "seam must start a background turn");
            spawned_sids.push(sid);
        }
        // Tracked set grew with the spawns (all still pending at this instant).
        assert!(reg.background_len() >= 1, "tracked tasks should be >=1");

        // Wait for all turns to finish by watching each session log get the brief.
        for sid in &spawned_sids {
            let log = reg.sessions().get(sid).expect("session present").log.clone();
            let mut seen = false;
            for _ in 0..100 {
                if log.events().iter().any(|e| matches!(e, SessionEvent::UserMessage { .. })) {
                    seen = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(seen, "session {sid} background turn did not run");
        }

        // After completion + prune, no background task remains -> no task leak.
        reg.prune_completed().await;
        assert_eq!(reg.background_len(), 0, "background joinset must drain to zero after completion");
    }
}
