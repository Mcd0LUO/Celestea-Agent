//! celestea-workers：WorkerRegistry — registry.tsv 原子读写 + 会话引用 + 驱动 seam（W185）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use celestea_core::{
    AgentLoop, AgentLoopService, Context, LlmService, SessionService, ToolRegistryService,
};
use celestea_session::{SessionMailbox, SessionRegistry};
use serde_json::{json, Value};
use tokio::task::JoinSet;

use crate::types::{WorkerEntry, WorkerStatus};

/// harness 侧 worker registry 服务：封装 registry.tsv 的原子读写，持有
/// SessionRegistry / SessionMailbox 引用（工具经它触达会话与队列），并携带
/// 可选的后台驱动 seam（Llm / ToolRegistry / AgentLoop，由插件 mount 时注入）。
pub struct WorkerRegistry {
    path: PathBuf,
    sessions: SessionRegistry,
    mailbox: SessionMailbox,
    source_label: RwLock<String>,
    llm: RwLock<Option<Arc<LlmService>>>,
    tools: RwLock<Option<Arc<ToolRegistryService>>>,
    agent_loop: RwLock<Option<Arc<dyn AgentLoop>>>,
    /// Tracks every fire-and-forget background turn (see
    /// [WorkerRegistry::drive_if_possible]) in a [tokio::task::JoinSet] so the
    /// set of running driver tasks stays observable, reaped on completion, and
    /// abortable on shutdown (W188).
    background: Mutex<JoinSet<()>>,
}

impl WorkerRegistry {
    /// 默认落盘路径：/tmp/celestea-workers-registry.tsv（可经构造参数覆盖）。
    pub fn default_tsv_path() -> PathBuf {
        PathBuf::from("/tmp/celestea-workers-registry.tsv")
    }

    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            sessions: SessionRegistry::new(),
            mailbox: SessionMailbox::new(),
            source_label: RwLock::new("harness-coordinator".to_string()),
            llm: RwLock::new(None),
            tools: RwLock::new(None),
            agent_loop: RwLock::new(None),
            background: Mutex::new(JoinSet::new()),
        }
    }

    pub fn with_default_path() -> Self {
        Self::new(Self::default_tsv_path())
    }

    pub fn tsv_path(&self) -> &Path {
        &self.path
    }

    /// SessionRegistry 引用（spawn 建会话 / send 解析目标）。
    pub fn sessions(&self) -> &SessionRegistry {
        &self.sessions
    }

    /// SessionMailbox 引用（send 入队）。
    pub fn mailbox(&self) -> &SessionMailbox {
        &self.mailbox
    }

    /// 发送者标签（session_send_message 的 from_label / sourceSession）。
    pub fn source_label(&self) -> String {
        self.source_label.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set_source_label(&self, label: impl Into<String>) {
        if let Ok(mut g) = self.source_label.write() {
            *g = label.into();
        }
    }

    /// 插件 mount 时注入后台驱动 seam；缺任一 → spawn 仅登记不驱动。
    pub fn attach_drivers(
        &self,
        llm: Option<Arc<LlmService>>,
        tools: Option<Arc<ToolRegistryService>>,
        agent_loop: Option<Arc<dyn AgentLoop>>,
    ) {
        if let Ok(mut g) = self.llm.write() {
            *g = llm;
        }
        if let Ok(mut g) = self.tools.write() {
            *g = tools;
        }
        if let Ok(mut g) = self.agent_loop.write() {
            *g = agent_loop;
        }
    }

    /// 三个驱动 seam 是否齐备（决定 spawn 是否后台驱动）。
    pub fn can_drive(&self) -> bool {
        let llm = self.llm.read().map(|g| g.is_some()).unwrap_or(false);
        let tools = self.tools.read().map(|g| g.is_some()).unwrap_or(false);
        let agent = self.agent_loop.read().map(|g| g.is_some()).unwrap_or(false);
        llm && tools && agent
    }

    // --- registry.tsv 读写 ---

    /// 读全表；文件缺失视为空表，坏行跳行不崩溃。
    pub fn read_entries(&self) -> Vec<WorkerEntry> {
        let content = match std::fs::read_to_string(&self.path) {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        content.lines().filter_map(WorkerEntry::parse_line).collect()
    }

    /// 原子写全表：先写同目录 tmp 文件，再 rename 覆盖（tmp+rename 原子替换）。
    pub fn write_entries(&self, entries: &[WorkerEntry]) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)?;
            }
        }
        let file_name = self
            .path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "registry.tsv".to_string());
        let tmp = self.path.with_file_name(format!("{file_name}.tmp-{}", std::process::id()));

        let mut content = String::new();
        for e in entries {
            content.push_str(&e.serialize_line());
            content.push('\n');
        }
        std::fs::write(&tmp, content)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// 按 wid upsert（存在则替换整行，否则追加）。
    pub fn upsert(&self, entry: WorkerEntry) -> std::io::Result<()> {
        let mut entries = self.read_entries();
        match entries.iter().position(|e| e.wid == entry.wid) {
            Some(pos) => entries[pos] = entry,
            None => entries.push(entry),
        }
        self.write_entries(&entries)
    }

    pub fn get_entry(&self, wid: &str) -> Option<WorkerEntry> {
        self.read_entries().into_iter().find(|e| e.wid == wid)
    }

    /// 汇总：缺省返回 RUNNING/DONE/FAILED 计数 + 全表；按 wid 过滤返回单条。
    pub fn summarize(&self, filter: Option<&str>) -> Value {
        let entries = self.read_entries();
        if let Some(wid) = filter {
            return match entries.iter().find(|e| e.wid == wid) {
                Some(e) => json!({ "ok": true, "wid": wid, "worker": e.to_json() }),
                None => json!({
                    "ok": false,
                    "step": "lookup",
                    "error": format!("no worker {wid} in registry"),
                }),
            };
        }
        let running = entries.iter().filter(|e| e.status == WorkerStatus::Running).count();
        let done = entries.iter().filter(|e| e.status == WorkerStatus::Done).count();
        let failed = entries.iter().filter(|e| e.status == WorkerStatus::Failed).count();
        json!({
            "ok": true,
            "total": entries.len(),
            "by_status": {
                "RUNNING": running,
                "DONE": done,
                "FAILED": failed,
            },
            "workers": entries.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
        })
    }

    /// 若驱动 seam 齐备且会话存在，tokio 后台驱动该会话一轮 run_turn。
    /// 返回是否真的启动了后台任务。
    pub async fn drive_if_possible(&self, sid: &str, brief: &str) -> bool {
        // F1 (W224): 每次新 spawn 前先收割已完成的后台驱动任务 —— 生产路径此前从不
        // 调用 prune_completed，完成但未收割的槽位在进程生命周期内无界累积（W222 F1）。
        self.prune_completed().await;

        let (Some(llm), Some(tools), Some(loop_)) = (
            self.llm.read().map(|g| g.clone()).unwrap_or(None),
            self.tools.read().map(|g| g.clone()).unwrap_or(None),
            self.agent_loop.read().map(|g| g.clone()).unwrap_or(None),
        ) else {
            return false;
        };
        let Some(session) = self.sessions.get(sid) else {
            return false;
        };

        // 每 worker 独立 Context：Llm / ToolRegistry 来自宿主（Arc 共享），
        // SessionService 指向该 worker 自己的 log（遮蔽宿主的会话）。
        let mut ctx = Context::new();
        ctx.provide(LlmService(llm.0.clone()));
        ctx.provide(ToolRegistryService(tools.0.clone()));
        ctx.provide(SessionService(session.log.clone()));
        ctx.provide(AgentLoopService(loop_.clone()));

        let brief = brief.to_string();
        let sid = sid.to_string();

        // Spawn into the tracked JoinSet instead of discarding the handle, so
        // background driver tasks can be observed, reaped on completion, and
        // aborted on shutdown (W188).
        let mut guard = self.background.lock().unwrap_or_else(|p| p.into_inner());
        guard.spawn(async move {
            if let Err(e) = loop_.run_turn(&ctx, &brief).await {
                eprintln!("[celestea-workers] {sid} background turn failed: {e}");
            }
        });
        true
    }

    /// Number of background driver tasks currently tracked (running or not yet
    /// reaped). Completed tasks are reclaimed by [WorkerRegistry::prune_completed].
    pub fn background_len(&self) -> usize {
        self.background.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Reap every finished background driver task from the [tokio::task::JoinSet],
    /// so the tracked set only ever holds still-pending work. Async because the
    /// join-set is owned under a std Mutex (no yield while locking).
    pub async fn prune_completed(&self) {
        let mut guard = self.background.lock().unwrap_or_else(|p| p.into_inner());
        while guard.try_join_next().is_some() {}
    }

    /// Abort every tracked background driver task and clear the set
    /// (shutdown / cancel path). Already-finished results are dropped.
    pub async fn abort_all(&self) {
        let mut guard = self.background.lock().unwrap_or_else(|p| p.into_inner());
        guard.abort_all();
        while guard.join_next().await.is_some() {}
    }
}

/// Service newtype so an Arc of [WorkerRegistry] can live in the Context TypeId map
/// (same pattern as LlmService / ToolRegistryService). Consumers resolve it via
/// Context::get::<WorkerRegistryService>().
pub struct WorkerRegistryService(pub Arc<WorkerRegistry>);

impl std::ops::Deref for WorkerRegistryService {
    type Target = WorkerRegistry;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

