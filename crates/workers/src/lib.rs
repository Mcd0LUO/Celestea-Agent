//! celestea-workers — harness 内置编排能力（W185）。
//!
//! 按 W180 设计 B1/B2/B3 落地的三个内置工具 + 插件挂载：
//!
//! - [spawn_worker]：在 harness 进程内拉起一个 worker 会话（SessionRegistry::create →
//!   命名 <wid>·<短名> → 可选 tokio 后台驱动 AgentLoop → 写 harness 侧 registry.tsv）。
//!   W232 起后台驱动升级为 mailbox 事件循环：先跑一轮 brief turn，随后阻塞在
//!   mailbox.recv(sid) 上，每条到达的消息以 content 为输入再跑一轮 turn（同 worker
//!   串行），直到会话被移除/purge（stop_driver）才退出。
//! - [session_send_message]：内部 SessionRegistry::resolve（id 直取 / 命名唯一 /
//!   多命中候选）→ SessionMailbox::send 入队（Notify 唤醒等待中的 worker 驱动循环）。
//! - [worker_status]：读 registry.tsv 返回 RUNNING/DONE/FAILED 汇总（RUNNING 行再按
//!   state 标注细分 in-turn / idle；可选按 wid 过滤）。
//! - W235 回执协议：spawn(report_to=…) 时注入中性提示（不再强制模型调工具）；
//!   brief turn 结束后由驱动循环机械执行——写 results/<wid>-<short>.md 报告 +
//!   mailbox 回执 WORKER_<wid>_DONE/FAILED（from=worker sid），Ok/Err 都执行，
//!   只在 brief turn 后执行一次；W241 起回执尾部追加 worker 会话日志最后一条
//!   AssistantMessage 的文本摘要（"答复: " 段，截断 ~200 字符、换行折叠）；
//!   报告基目录可经
//!   [WorkerRegistry::set_results_dir] 注入（缺省 "results"，相对进程 CWD）。
//!
//! [WorkersPlugin] 在 mount 时 provide 一个含 builtin + 三内置工具的组合
//! [ToolRegistryService]，并把 [WorkerRegistry]（registry.tsv 读写 + SessionRegistry/
//! SessionMailbox 引用 + 驱动 seam）以 [WorkerRegistryService] 提供进 Context。

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
        AgentConfig, AgentError, Context, Llm, LlmError, LlmStream, Message, ModelRequest, LlmService,
        SessionEvent, SessionLog, SessionService, StreamEvent, ToolGuard, ToolInput, ToolOutput, ToolRegistry,
        ToolRegistryService, ToolSpec, AgentLoop, Tool,
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
        // W234: utc_now 带 'Z' 时区标记（YYYY-MM-DD_HH:MM:SSZ），不再误导为本地时间。
        let now = utc_now();
        assert_eq!(now.len(), 20, "expected YYYY-MM-DD_HH:MM:SSZ, got {now}");
        assert!(now.ends_with('Z'), "utc_now must carry the Z timezone marker: {now}");
        assert!(now.starts_with("20"), "now should be 2000s: {now}");
        // 新格式（带 Z）与旧格式（无后缀）都能被 parse_utc 反向解析：读旧行不崩。
        assert!(parse_utc(&now).is_some(), "Z-suffixed timestamp must parse: {now}");
        assert_eq!(parse_utc(&now), parse_utc(&now[..19]));
        assert_eq!(
            parse_utc("2026-09-06_17:24:17"),
            parse_utc("2026-09-06_17:24:17Z"),
            "old rows without Z must parse identically"
        );
    }

    // ---- W234 B: 跨进程 registry 行治理（proc 标记） -------------------------

    #[tokio::test]
    async fn worker_status_view_excludes_foreign_proc_rows() {
        let path = temp_tsv("w234-status");
        // 预置其他进程（旧格式，无 proc）的残留行：sess 与本进程会话空间撞车。
        std::fs::write(
            &path,
            concat!(
                "W216T\t2026-09-06_17:24:17\tRUNNING\tsess=session-0 state=idle brief=ghost1\n",
                "W101\t2026-09-06_17:24:18\tDONE\tsess=session-1\n",
                "W001\t2026-09-06_17:24:19\tRUNNING\tsess=session-2\n",
            ),
        )
        .unwrap();

        let reg = Arc::new(WorkerRegistry::new(&path));
        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        spawn.execute(json!({ "wid": "WOWN", "brief": "own" })).await.unwrap();

        // 原始读不受影响：upsert / 看门狗整表重写仍保留全部行（不丢他进程数据）。
        assert_eq!(reg.read_entries().len(), 4, "raw read must keep foreign rows");

        let status = tool_by_name(&tools, "worker_status");
        let all = status.execute(json!({})).await.unwrap();
        assert_eq!(all["ok"], json!(true));
        assert_eq!(all["total"], json!(1), "view counts only own-process rows: {all}");
        assert_eq!(all["by_status"]["RUNNING"], json!(1));
        assert_eq!(all["by_status"]["DONE"], json!(0), "foreign DONE row must not be counted");
        assert_eq!(all["by_state"]["idle"], json!(0), "foreign RUNNING state=idle must not be counted");
        assert_eq!(all["by_state"]["in-turn"], json!(0));
        assert_eq!(all["workers"][0]["wid"], json!("WOWN"));

        // 按 wid 过滤：他进程行不可见；本进程行可见且带 proc 标记。
        let filtered = status.execute(json!({ "wid": "W216T" })).await.unwrap();
        assert_eq!(filtered["ok"], json!(false), "foreign wid lookup must miss: {filtered}");
        assert_eq!(filtered["step"], json!("lookup"));

        let own = status.execute(json!({ "wid": "WOWN" })).await.unwrap();
        assert_eq!(own["ok"], json!(true));
        assert_eq!(own["worker"]["wid"], json!("WOWN"));
        assert_eq!(own["worker"]["proc"], json!(std::process::id()));
    }

    #[tokio::test]
    async fn spawn_sid_collision_state_lands_on_own_row() {
        let path = temp_tsv("w234-collide");
        // 预置旧进程残留行：sess=session-0、无 proc（旧格式），模拟跨进程撞车。
        std::fs::write(
            &path,
            "W216T\t2026-09-06_17:24:17\tRUNNING\tsess=session-0 state=idle brief=ghost\n",
        )
        .unwrap();

        let reg = Arc::new(WorkerRegistry::new(&path));
        let recorder = Arc::new(RecordingLoop::new(true)); // 门控：in-turn 可观测
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn.execute(json!({ "wid": "WNEW", "brief": "fresh task" })).await.unwrap();
        assert_eq!(out["ok"], json!(true));
        // 新进程 SessionRegistry next_id 归零 → 新会话也是 session-0（撞车）。
        assert_eq!(out["sessionId"], json!("session-0"));

        // 驱动的 in-turn 标注必须落在本进程行（WNEW，带 proc）；旧行不得被改写。
        wait_until(|| reg.get_entry("WNEW").and_then(|e| e.state()) == Some("in-turn".to_string()), 3000).await;

        let entries = reg.read_entries();
        let ghost = entries.iter().find(|e| e.wid == "W216T").expect("ghost row preserved");
        let own = entries.iter().find(|e| e.wid == "WNEW").expect("own row present");
        assert_eq!(ghost.get_extra("state").as_deref(), Some("idle"), "ghost row must not be touched: {ghost:?}");
        assert_eq!(ghost.started_at, "2026-09-06_17:24:17", "ghost started_at must stay intact");
        assert_eq!(ghost.proc_id(), None, "old row has no proc token");
        assert_eq!(own.proc_id(), Some(std::process::id()), "own row stamped with this pid");
        assert_eq!(own.state().as_deref(), Some("in-turn"));

        // 收尾：放行 → idle，释放会话让驱动退出。
        recorder.release();
        wait_until(|| reg.get_entry("WNEW").and_then(|e| e.state()) == Some("idle".to_string()), 3000).await;
        let sid = out["sessionId"].as_str().unwrap().to_string();
        reg.sessions().remove(&sid);
        reg.mailbox().purge(&sid);
        reg.stop_driver(&sid);
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

        // Fire N background drivers through the seam.
        const N: usize = 40;
        let mut spawned_sids = Vec::new();
        for i in 0..N {
            let sid = reg.sessions().create(SessionSpec { title: format!("w{i}").into(), ..Default::default() });
            let started = reg.drive_if_possible(&sid, &format!("task {i}")).await;
            assert!(started, "seam must start a background driver");
            spawned_sids.push(sid);
        }
        // Tracked set grew with the spawns (all still pending at this instant).
        assert!(reg.background_len() >= 1, "tracked tasks should be >=1");

        // Wait for all brief turns to actually finish (TurnEnd is appended before
        // the driver enters its mailbox wait).
        for sid in &spawned_sids {
            let log = reg.sessions().get(sid).expect("session present").log.clone();
            let mut ended = false;
            for _ in 0..200 {
                if log.events().iter().any(|e| matches!(e, SessionEvent::TurnEnd { .. })) {
                    ended = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(ended, "session {sid} background turn did not finish");
        }

        // W232: 驱动任务现在是 mailbox 事件循环——brief turn 结束后随会话存活，
        // 不会自行完成。退出条件是会话被移除/purge + stop_driver（看门狗
        // release_session 语义）。逐一释放后任务退出、槽位被收割归零。
        for sid in &spawned_sids {
            assert!(reg.sessions().remove(sid), "remove {sid}");
            reg.mailbox().purge(sid);
            reg.stop_driver(sid);
        }
        for _ in 0..200 {
            reg.prune_completed().await;
            if reg.background_len() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(reg.background_len(), 0, "background joinset must drain to zero after release");
    }

    // ---- W224 F1: 每次新 spawn 前收割已结束的后台驱动任务（生产路径不再无界累积） ----

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drive_reaps_completed_tasks_on_next_spawn() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("stress-reap")));
        let llm = LlmService(Arc::new(FakeLlm::new(vec![Message::assistant_text("hi")])));
        let tools_svc = ToolRegistryService(Arc::new(EmptyRegistry));
        let agent: Arc<dyn AgentLoop> = Arc::new(DefaultAgentLoop::new(AgentConfig::default()));
        reg.attach_drivers(Some(Arc::new(llm)), Some(Arc::new(tools_svc)), Some(agent));
        assert!(reg.can_drive());

        // 逐轮 drive + 等待 brief 轮完成 + 释放会话（W232 事件循环驱动随会话
        // 存活，释放即退出）：若每次新 drive 前不收割（旧行为），已退出槽位会
        // 随轮次线性累积；F1 修后每轮 start 处先 prune_completed。
        const N: usize = 20;
        for i in 0..N {
            let sid = reg.sessions().create(SessionSpec { title: format!("r{i}").into(), ..Default::default() });
            assert!(reg.drive_if_possible(&sid, &format!("task {i}")).await, "seam must start a background driver");

            // 等本轮的 TurnEnd 落进该会话 log（brief 轮结束，driver 进入 mailbox 等待）。
            let log = reg.sessions().get(&sid).expect("session present").log.clone();
            let mut ended = false;
            for _ in 0..200 {
                if log.events().iter().any(|e| matches!(e, SessionEvent::TurnEnd { .. })) {
                    ended = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(ended, "session {sid} background turn did not finish");

            // W232: 模拟看门狗裁决结束（release_session 语义），驱动退出。
            assert!(reg.sessions().remove(&sid), "remove {sid}");
            reg.mailbox().purge(&sid);
            reg.stop_driver(&sid);

            // F1: 上一轮已退出的槽位会被下一次 drive 起点处的 prune 收割——
            // 全程 background_len 不超过 1（当前活 worker 自己的槽位）。
            // JoinSet::len 含「已完成未收割」的槽位，因此轮询里先 prune 再检查
            //（等价于下一次 drive 起点做的收割）。
            for _ in 0..100 {
                reg.prune_completed().await;
                if reg.background_len() <= 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(
                reg.background_len() <= 1,
                "iteration {i}: completed slots must be reaped on next spawn, background_len={}",
                reg.background_len()
            );
        }
        // 最后一轮释放的驱动需要一点收尾时间：轮询 prune 直到归零（F1 语义不变）。
        for _ in 0..200 {
            reg.prune_completed().await;
            if reg.background_len() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(reg.background_len(), 0, "background joinset must drain to zero after final prune");
    }

    // ---- W232: mailbox 事件循环（消息真正驱动目标 worker 的轮次） ------------------

    /// 记录每个 run_turn 输入（可选门控阻塞）的 fake AgentLoop：
    /// - 复刻 DefaultAgentLoop 的开场记账（TurnStart/UserMessage/TurnEnd 落进
    ///   ctx 里的 SessionService 日志），供 worker log 断言；
    /// - gated=true 时 run_turn 末尾阻塞在 Notify 上，直到 release() 放行，
    ///   使 in-turn 状态标注可被确定性观测。
    struct RecordingLoop {
        inputs: Mutex<Vec<String>>,
        gate: tokio::sync::Notify,
        gated: bool,
        /// W235: true 时 run_turn 返回 Err（测试 brief turn 失败分支的回执协议）。
        fail: bool,
        /// W241: run_turn 末尾追加的 AssistantMessage 文本（测回执携带答复摘要）。
        assistant: Option<String>,
    }
    impl RecordingLoop {
        fn new(gated: bool) -> Self {
            Self {
                inputs: Mutex::new(Vec::new()),
                gate: tokio::sync::Notify::new(),
                gated,
                fail: false,
                assistant: None,
            }
        }
        fn failing(gated: bool) -> Self {
            Self {
                inputs: Mutex::new(Vec::new()),
                gate: tokio::sync::Notify::new(),
                gated,
                fail: true,
                assistant: None,
            }
        }
        /// W241: 每轮 turn 落一条 AssistantMessage（Ok 路径）。
        fn answering(text: impl Into<String>) -> Self {
            Self {
                inputs: Mutex::new(Vec::new()),
                gate: tokio::sync::Notify::new(),
                gated: false,
                fail: false,
                assistant: Some(text.into()),
            }
        }
        /// W241: 落一条 AssistantMessage 后返回 Err（失败分支回执同样带答复）。
        fn failing_answering(text: impl Into<String>) -> Self {
            Self {
                inputs: Mutex::new(Vec::new()),
                gate: tokio::sync::Notify::new(),
                gated: false,
                fail: true,
                assistant: Some(text.into()),
            }
        }
        fn inputs(&self) -> Vec<String> {
            self.inputs.lock().unwrap().clone()
        }
        fn release(&self) {
            self.gate.notify_waiters();
        }
    }
    #[async_trait]
    impl AgentLoop for RecordingLoop {
        async fn run_turn(&self, ctx: &Context, input: &str) -> Result<(), AgentError> {
            self.inputs.lock().unwrap().push(input.to_string());
            if let Some(svc) = ctx.get::<SessionService>() {
                let id = format!("rec-{}", self.inputs.lock().unwrap().len());
                svc.append(SessionEvent::TurnStart { id: id.clone() });
                svc.append(SessionEvent::UserMessage { text: input.to_string() });
                svc.append(SessionEvent::TurnEnd { id });
                // W241: 模拟 loop 的最终答复落进会话日志（fail 分支同理，供
                // 回执协议取最后一条 AssistantMessage）。
                if let Some(answer) = &self.assistant {
                    svc.append(SessionEvent::AssistantMessage { text: answer.clone() });
                }
            }
            if self.gated {
                self.gate.notified().await;
            }
            if self.fail {
                return Err(AgentError("W235 test: brief turn failed".into()));
            }
            Ok(())
        }
    }

    /// 轮询等待条件成立（10ms 步长），超时 panic。
    async fn wait_until<F: FnMut() -> bool>(mut cond: F, max_ms: u64) {
        for _ in 0..(max_ms / 10) {
            if cond() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("condition not met within {max_ms} ms");
    }

    fn attach_recording(reg: &Arc<WorkerRegistry>, recorder: Arc<RecordingLoop>) {
        let llm = LlmService(Arc::new(FakeLlm::new(vec![Message::assistant_text("hi")])));
        let tools_svc = ToolRegistryService(Arc::new(EmptyRegistry));
        reg.attach_drivers(Some(Arc::new(llm)), Some(Arc::new(tools_svc)), Some(recorder));
    }

    #[tokio::test]
    async fn sent_message_drives_a_turn_in_target_worker() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w232-send")));
        let recorder = Arc::new(RecordingLoop::new(false));
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn.execute(json!({ "wid": "WMSG", "brief": "initial brief" })).await.unwrap();
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["driven"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // 第一轮：brief turn 被驱动（现有行为）。
        wait_until(|| recorder.inputs().iter().any(|i| i == "initial brief"), 3000).await;
        // brief 轮结束后驱动进入 mailbox 等待 → 状态标注 idle。
        wait_until(
            || reg.get_entry("WMSG").and_then(|e| e.state()) == Some("idle".to_string()),
            3000,
        )
        .await;

        // 投递一条消息 → 目标 worker 真的跑了一轮包含该内容的 turn。
        let send = tool_by_name(&tools, "session_send_message");
        let out = send.execute(json!({ "target": sid.clone(), "content": "please follow up" })).await.unwrap();
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["queued"], json!(true));

        wait_until(|| recorder.inputs().iter().any(|i| i == "please follow up"), 3000).await;
        // 串行语义：inputs 顺序 = [brief, 消息]；消息被消费，不再排队。
        assert_eq!(recorder.inputs(), vec!["initial brief".to_string(), "please follow up".to_string()]);
        assert_eq!(reg.mailbox().pending(&sid), 0, "message must be consumed by the loop");

        // 该内容以 UserMessage 落进 worker 自己的 log。
        let log = reg.sessions().get(&sid).expect("session registered").log.clone();
        assert!(
            log.events()
                .iter()
                .any(|e| matches!(e, SessionEvent::UserMessage { text } if text == "please follow up")),
            "worker log must contain the message as a user turn"
        );
    }

    #[tokio::test]
    async fn driver_exits_when_session_released() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w232-stop")));
        let recorder = Arc::new(RecordingLoop::new(false));
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn.execute(json!({ "wid": "WSTOP", "brief": "stop me" })).await.unwrap();
        let sid = out["sessionId"].as_str().unwrap().to_string();

        wait_until(|| recorder.inputs().iter().any(|i| i == "stop me"), 3000).await;
        assert_eq!(reg.background_len(), 1, "event-loop driver stays alive after its brief turn");

        // 看门狗 release_session 语义（W224 F2 + W232 stop）：remove + purge + stop。
        assert!(reg.sessions().remove(&sid), "remove session");
        reg.mailbox().purge(&sid);
        reg.stop_driver(&sid);

        // 驱动退出 + prune 收割 → JoinSet 归零（不残留阻塞在 recv 的任务）。
        for _ in 0..200 {
            reg.prune_completed().await;
            if reg.background_len() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(reg.background_len(), 0, "released session's driver must exit");
    }

    #[tokio::test]
    async fn worker_state_flows_in_turn_and_idle() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w232-state")));
        let recorder = Arc::new(RecordingLoop::new(true)); // 门控：in-turn 可观测
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn.execute(json!({ "wid": "WSTATE", "brief": "gated brief" })).await.unwrap();
        assert_eq!(out["driven"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // spawn → RUNNING；brief turn 在跑 → RUNNING + state=in-turn（gate 阻塞住）。
        wait_until(
            || reg.get_entry("WSTATE").and_then(|e| e.state()) == Some("in-turn".to_string()),
            3000,
        )
        .await;
        assert_eq!(reg.get_entry("WSTATE").unwrap().status, WorkerStatus::Running);

        // 放行 brief turn → 等待 mailbox → state=idle，状态仍是 RUNNING。
        recorder.release();
        wait_until(
            || reg.get_entry("WSTATE").and_then(|e| e.state()) == Some("idle".to_string()),
            3000,
        )
        .await;
        assert_eq!(reg.get_entry("WSTATE").unwrap().status, WorkerStatus::Running);

        // summarize 的 by_state 细分可见（idle 计 1）。
        let summary = reg.summarize(None);
        assert_eq!(summary["by_state"]["idle"], json!(1));
        assert_eq!(summary["by_state"]["in-turn"], json!(0));

        // 消息驱动第二轮：再次 in-turn → 放行 → 回 idle。
        reg.mailbox().send(&sid, "second turn", "coordinator");
        wait_until(
            || reg.get_entry("WSTATE").and_then(|e| e.state()) == Some("in-turn".to_string()),
            3000,
        )
        .await;
        recorder.release();
        wait_until(
            || reg.get_entry("WSTATE").and_then(|e| e.state()) == Some("idle".to_string()),
            3000,
        )
        .await;
        assert_eq!(recorder.inputs(), vec!["gated brief".to_string(), "second turn".to_string()]);
        assert_eq!(reg.get_entry("WSTATE").unwrap().status, WorkerStatus::Running);

        // 终态仍由看门狗裁决：驱动只标注 state，不自行 DONE/FAILED。
        reg.sessions().remove(&sid);
        reg.mailbox().purge(&sid);
        reg.stop_driver(&sid);
    }

    // ---- W234 A + W235 B: report_to 注入（内容改为中性提示，不再强制工具调用） ----

    #[tokio::test]
    async fn spawn_injects_report_to_neutral_hint_into_brief_and_tsv() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w234-report")));
        // 该 worker 带 report_to → brief 轮后回执协议会写报告文件；注入
        // tempdir 基目录，避免污染测试进程 CWD。
        let results = temp_results("w234-report");
        let _ = std::fs::remove_dir_all(&results);
        reg.set_results_dir(results.clone());
        let recorder = Arc::new(RecordingLoop::new(false));
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn
            .execute(json!({
                "wid": "WPROBE",
                "brief": "只回复两个汉字：收到。然后结束。",
                "report_to": "cli-main"
            }))
            .await
            .unwrap();
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["driven"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // W235 B: 驱动收到的 brief = 原始简报 + 中性回执提示（不再强制工具调用，
        // 避免与主简报指令冲突、避免 LLM 与驱动双写不一致）。
        wait_until(
            || recorder.inputs().iter().any(|i| {
                i.starts_with("只回复两个汉字：收到。然后结束。")
                    && i.contains("完成后引擎会自动生成报告并发送回执")
            }),
            3000,
        )
        .await;
        let injected = recorder.inputs().into_iter().next().expect("brief turn input");
        assert!(
            injected.contains("你只需专注完成任务本身"),
            "injected brief must carry the neutral hint: {injected}"
        );
        assert!(!injected.contains("write_file"), "injected brief must not force tool calls: {injected}");
        assert!(!injected.contains("session_send_message"), "injected brief must not force tool calls: {injected}");
        assert!(!injected.contains("【强制交付】"), "injected brief must not be mandatory: {injected}");

        // tsv 行：report_to token 落盘；brief token 存注入后的文本（仍截断 300 + sanitize）。
        // brief 值可含空格，get_extra 按空白拆块只取首块，这里直接断言整行 extra。
        let entry = reg.get_entry("WPROBE").expect("registry entry written");
        assert_eq!(entry.get_extra("report_to").as_deref(), Some("cli-main"));
        assert!(
            entry.extra.contains("完成后引擎会自动生成报告并发送回执"),
            "tsv brief token must carry the hint: {}",
            entry.extra
        );
        assert!(!entry.extra.contains('\t') && !entry.extra.contains('\n'), "extra sanitized: {}", entry.extra);

        // 收尾：释放会话让驱动退出。
        reg.sessions().remove(&sid);
        reg.mailbox().purge(&sid);
        reg.stop_driver(&sid);
        let _ = std::fs::remove_dir_all(&results);
    }

    #[tokio::test]
    async fn spawn_report_to_injects_even_without_drivers() {
        // 未接驱动 seam（仅登记不驱动）时，tsv 的 brief token 同样存注入后文本。
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w234-report-nodrv")));
        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn
            .execute(json!({ "wid": "WNODRV", "brief": "do it", "report_to": "cli-main" }))
            .await
            .unwrap();
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["driven"], json!(false));

        let entry = reg.get_entry("WNODRV").expect("registry entry written");
        assert!(
            entry.extra.contains("完成后引擎会自动生成报告并发送回执"),
            "neutral hint injected even when not driven: {}",
            entry.extra
        );
        assert!(entry.extra.contains("report_to=cli-main"), "report_to target present: {}", entry.extra);
        assert!(!entry.extra.contains('\t') && !entry.extra.contains('\n'), "extra sanitized: {}", entry.extra);
    }

    // ---- W235 A: 回执协议由驱动循环机械执行（不依赖模型遵从） ------------------

    /// 每个测试独立的 results 基目录：经 reg.set_results_dir 注入，避免
    /// 测试进程 CWD 下的 results/ 被污染（最小方案：可注入基目录，缺省 "results"）。
    fn temp_results(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("celestea-workers-results-{tag}-{}", std::process::id()))
    }

    /// 收尾：释放 worker 会话让驱动退出，并清理注入的 results 目录。
    fn cleanup(reg: &WorkerRegistry, sid: &str, results: &PathBuf) {
        reg.sessions().remove(sid);
        reg.mailbox().purge(sid);
        reg.stop_driver(sid);
        let _ = std::fs::remove_dir_all(results);
    }

    #[test]
    fn report_file_stem_sanitizes_illegal_chars() {
        // 消毒语义仿照 crates/session file_name_for：非 [A-Za-z0-9._-] → '_'。
        use crate::registry::sanitize_file_stem;
        assert_eq!(sanitize_file_stem("W101"), "W101");
        assert_eq!(sanitize_file_stem("../etc/passwd"), ".._etc_passwd");
        assert_eq!(sanitize_file_stem("W 1/2:3"), "W_1_2_3");
        assert_eq!(sanitize_file_stem("机械回执"), "____");
        assert_eq!(sanitize_file_stem(""), "worker");
    }

    #[tokio::test]
    async fn receipt_protocol_runs_after_brief_turn_ok() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w235-receipt-ok")));
        let results = temp_results("w235-receipt-ok");
        let _ = std::fs::remove_dir_all(&results);
        reg.set_results_dir(results.clone());

        let recorder = Arc::new(RecordingLoop::answering("第一行：任务完成。\n第二行：结论见报告。"));
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn
            .execute(json!({
                "wid": "W235T",
                "brief": "mechanical receipt",
                "title": "receipt-ok",
                "report_to": "cli-main"
            }))
            .await
            .unwrap();
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["driven"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // brief turn 结束 → 机械回执入 cli-main 队列（from=本 worker sid）。
        wait_until(|| reg.mailbox().pending("cli-main") == 1, 3000).await;
        let msgs = reg.mailbox().poll("cli-main");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].from_label, sid, "receipt must come from the worker session");
        assert!(msgs[0].content.starts_with("WORKER_W235T_DONE"), "receipt: {}", msgs[0].content);
        assert!(msgs[0].content.contains("报告 results/W235T-receipt-ok.md"), "receipt: {}", msgs[0].content);
        // W241: 回执尾部携带 worker 最终答复（最后一条 AssistantMessage，换行折叠成空格）。
        assert!(
            msgs[0].content.contains("答复: 第一行：任务完成。 第二行：结论见报告。"),
            "receipt must carry the worker's final assistant reply: {}",
            msgs[0].content
        );

        // 报告文件存在且含 status/title/简报摘要/会话尾记录。
        let report = results.join("W235T-receipt-ok.md");
        assert!(report.exists(), "report file must exist at {report:?}");
        let text = std::fs::read_to_string(&report).unwrap();
        assert!(text.contains("# Worker W235T 完成报告"), "report: {text}");
        assert!(text.contains("title: receipt-ok"), "report: {text}");
        assert!(text.contains("status: OK"), "report: {text}");
        assert!(text.contains("mechanical receipt"), "report brief summary: {text}");
        assert!(text.contains("## 会话尾记录"), "report: {text}");
        assert!(text.contains("- user: mechanical receipt"), "report tail: {text}");

        // 协议只执行一次：mailbox 消息驱动的轮次不重复回执。
        reg.mailbox().send(&sid, "follow-up", "coordinator");
        wait_until(|| recorder.inputs().iter().any(|i| i == "follow-up"), 3000).await;
        assert_eq!(reg.mailbox().pending("cli-main"), 0, "mailbox turn must not re-run the receipt protocol");

        cleanup(&reg, &sid, &results);
    }

    #[tokio::test]
    async fn receipt_protocol_reports_failure_on_brief_turn_err() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w235-receipt-err")));
        let results = temp_results("w235-receipt-err");
        let _ = std::fs::remove_dir_all(&results);
        reg.set_results_dir(results.clone());

        let recorder = Arc::new(RecordingLoop::failing_answering("已尽力尝试，卡在 X 上。"));
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn
            .execute(json!({
                "wid": "W235E",
                "brief": "will fail",
                "title": "fail-case",
                "report_to": "cli-main"
            }))
            .await
            .unwrap();
        assert_eq!(out["ok"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // brief turn Err → 机械回执 FAILED（带错误摘要 + 报告路径）。
        wait_until(|| reg.mailbox().pending("cli-main") == 1, 3000).await;
        let msgs = reg.mailbox().poll("cli-main");
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].content.starts_with("WORKER_W235E_FAILED"), "receipt: {}", msgs[0].content);
        assert!(
            msgs[0].content.contains("W235 test: brief turn failed"),
            "receipt must carry the error: {}",
            msgs[0].content
        );
        assert!(msgs[0].content.contains("报告 results/W235E-fail-case.md"), "receipt: {}", msgs[0].content);
        // W241: 失败分支同理带上最后 assistant 文本（若有）。
        assert!(
            msgs[0].content.contains("答复: 已尽力尝试，卡在 X 上。"),
            "failed receipt must carry the last assistant text: {}",
            msgs[0].content
        );

        // 报告文件写失败状态。
        let report = results.join("W235E-fail-case.md");
        assert!(report.exists(), "report file must exist at {report:?}");
        let text = std::fs::read_to_string(&report).unwrap();
        assert!(text.contains("status: ERR"), "report must record failure: {text}");
        assert!(text.contains("W235 test: brief turn failed"), "report: {text}");

        cleanup(&reg, &sid, &results);
    }

    #[tokio::test]
    async fn no_report_to_means_no_file_no_receipt() {
        let reg = Arc::new(WorkerRegistry::new(temp_tsv("w235-noreport")));
        let results = temp_results("w235-noreport");
        let _ = std::fs::remove_dir_all(&results);
        reg.set_results_dir(results.clone());

        let recorder = Arc::new(RecordingLoop::new(false));
        attach_recording(&reg, recorder.clone());

        let tools = worker_tools_with(reg.clone());
        let spawn = tool_by_name(&tools, "spawn_worker");
        let out = spawn
            .execute(json!({ "wid": "W235N", "brief": "quiet task", "title": "no-receipt" }))
            .await
            .unwrap();
        assert_eq!(out["ok"], json!(true));
        let sid = out["sessionId"].as_str().unwrap().to_string();

        // brief turn 结束（idle 标注出现）后：无报告文件、无任何回执。
        wait_until(|| reg.get_entry("W235N").and_then(|e| e.state()) == Some("idle".to_string()), 3000).await;
        assert!(!results.join("W235N-no-receipt.md").exists(), "no report file without report_to");
        assert!(!results.exists(), "results dir must not even be created without report_to");
        assert_eq!(reg.mailbox().pending_total(), 0, "no receipt without report_to");

        cleanup(&reg, &sid, &results);
    }


    // ---- W241: 回执携带答复摘要 + 工具描述闭环 --------------------------------

    #[test]
    fn last_assistant_summary_takes_last_folds_and_truncates() {
        use crate::registry::last_assistant_summary;
        let long: String = "第一行。\n第二行。".to_string() + &"x".repeat(300);
        let events = vec![
            SessionEvent::AssistantMessage { text: "early reply".into() },
            SessionEvent::UserMessage { text: "ping".into() },
            SessionEvent::AssistantMessage { text: long.clone() },
        ];
        let summary = last_assistant_summary(&events).expect("last assistant text");
        assert!(!summary.contains('\n'), "newlines folded to spaces: {summary}");
        assert!(summary.starts_with("第一行。 第二行。"), "summary: {summary}");
        assert!(summary.chars().count() <= 200, "truncated to ~200 chars: {}", summary.chars().count());
        assert!(!summary.contains("early reply"), "must take the LAST assistant message: {summary}");

        // 无 assistant 记录 → None（回执不带 "答复: " 段）。
        assert!(last_assistant_summary(&[]).is_none());
        assert!(last_assistant_summary(&[SessionEvent::UserMessage { text: "only user".into() }]).is_none());
    }

    #[test]
    fn tool_specs_describe_receipt_wakeup_collaboration_loop() {
        let tools = worker_tools();

        // spawn_worker：主 agent 应知道 "spawn 后等回执 / 查 worker_status" 的协作模式。
        let spawn = tool_by_name(&tools, "spawn_worker").spec();
        assert!(spawn.description.contains("回执"), "spawn description must mention the receipt: {}", spawn.description);
        assert!(spawn.description.contains("唤醒"), "spawn description must mention the wake-up: {}", spawn.description);
        assert!(spawn.description.contains("worker_status"), "spawn description must mention worker_status: {}", spawn.description);
        assert!(spawn.description.contains("整合"), "spawn description must mention integrating conclusions: {}", spawn.description);
        let report_to = spawn.parameters["properties"]["report_to"]["description"]
            .as_str()
            .expect("report_to param description");
        assert!(report_to.contains("唤醒"), "report_to description must mention wake-up: {report_to}");
        assert!(report_to.contains("读报告"), "report_to description must mention reading the report: {report_to}");

        // session_send_message：投递消息成为目标会话新一轮用户输入（唤醒语义）。
        let send = tool_by_name(&tools, "session_send_message").spec();
        assert!(send.description.contains("唤醒"), "send description must mention wake-up: {}", send.description);
        assert!(
            send.description.contains("新一轮的用户输入"),
            "send description must mention new-turn user input: {}",
            send.description
        );
        assert!(send.description.contains("worker 回执"), "send description must mention worker receipt: {}", send.description);
    }
}
