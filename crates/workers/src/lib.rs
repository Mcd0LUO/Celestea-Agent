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

use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use celestea_core::{
    AgentLoop, AgentLoopService, Context, LlmService, Plugin, SessionService, Tool,
    ToolRegistry, ToolRegistryService, ToolSpec,
};
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use celestea_session::{ResolveError, SessionMailbox, SessionRegistry, SessionSpec};
use tokio::task::JoinSet;
use serde_json::{json, Value};

// ============================================================================
// 7. WatchdogPlugin——看门狗后台巡检（W186）
// ============================================================================
mod watchdog;
pub use watchdog::{has_deliverable, session_alive, in_grace, parse_utc, WatchAction, Watchdog, WatchdogConfig};

// ============================================================================
// 1. Worker 状态与 registry.tsv 行（沿用 dsh 契约：wid\tt0\tstatus\textra）
// ============================================================================

/// Worker 生命周期状态机（RUNNING → DONE | FAILED，语义同 dsh 契约）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStatus {
    Running,
    Done,
    Failed,
}

impl fmt::Display for WorkerStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WorkerStatus::Running => write!(f, "RUNNING"),
            WorkerStatus::Done => write!(f, "DONE"),
            WorkerStatus::Failed => write!(f, "FAILED"),
        }
    }
}

impl FromStr for WorkerStatus {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_uppercase().as_str() {
            "RUNNING" => Ok(WorkerStatus::Running),
            "DONE" => Ok(WorkerStatus::Done),
            "FAILED" => Ok(WorkerStatus::Failed),
            _ => Err(()),
        }
    }
}

/// registry.tsv 的一行：wid、起始时间、状态、extra（extra 带 sess=/ws=/title= 等 token）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerEntry {
    pub wid: String,
    pub started_at: String,
    pub status: WorkerStatus,
    pub extra: String,
}

impl WorkerEntry {
    /// 序列化为契约行。wid/started_at/extra 在写入前均已消毒（无 tab/换行）。
    pub fn serialize_line(&self) -> String {
        format!("{}\t{}\t{}\t{}", self.wid, self.started_at, self.status, self.extra)
    }

    /// 解析一行；任何字段缺失、状态非法都返回 None（解析失败跳行不崩溃）。
    pub fn parse_line(line: &str) -> Option<Self> {
        let mut parts = line.split('\t');
        let wid = parts.next()?.trim();
        let started_at = parts.next()?.trim();
        let status = parts.next()?.trim();
        let extra = parts.next()?;
        if wid.is_empty() || started_at.is_empty() {
            return None;
        }
        let status = WorkerStatus::from_str(status).ok()?;
        Some(Self {
            wid: wid.to_string(),
            started_at: started_at.to_string(),
            status,
            extra: extra.to_string(),
        })
    }

    /// 从 extra 中取 k=v token（token 以空白分隔，extra 本身可含空格）。
    pub fn get_extra(&self, key: &str) -> Option<String> {
        self.extra.split_whitespace().find_map(|tok| {
            let (k, v) = tok.split_once('=')?;
            (k == key).then(|| v.to_string())
        })
    }

    /// 面向 AI 的 JSON 视图。
    pub fn to_json(&self) -> Value {
        json!({
            "wid": self.wid,
            "started_at": self.started_at,
            "status": self.status.to_string(),
            "sess": self.get_extra("sess").unwrap_or_default(),
            "ws": self.get_extra("ws").unwrap_or_default(),
            "title": self.get_extra("title").unwrap_or_default(),
            "driven": self.get_extra("driven").unwrap_or_default(),
            "extra": self.extra,
        })
    }
}

// ============================================================================
// 2. 时间戳（无 chrono 依赖的 UTC 民用历格式化，对齐 dsh 的 %Y-%m-%d_%H:%M:%S）
// ============================================================================

pub(crate) fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_utc(secs)
}

/// Howard Hinnant 的 civil-from-days 算法；对任意 i64 秒（含前纪元）都正确。
pub fn format_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if mth <= 2 { y + 1 } else { y };

    format!("{year:04}-{mth:02}-{d:02}_{h:02}:{m:02}:{s:02}")
}

// ============================================================================
// 3. WorkerRegistry — registry.tsv 读写（tmp+rename 原子替换）+ 会话引用 + 驱动 seam
// ============================================================================

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

// ============================================================================
// 4. 工具实现（spawn_worker / session_send_message / worker_status）
// ============================================================================

/// 面向 AI 的契约失败返回（与 dsh 插件一致的 {ok:false, step, error} 形状）。
fn contract_err(step: &str, error: impl Into<String>) -> Value {
    json!({ "ok": false, "step": step, "error": error.into() })
}

pub(crate) fn sanitize_extra(v: &str) -> String {
    v.replace(['\t', '\n', '\r'], " ")
}

fn truncate_chars(v: &str, max: usize) -> String {
    if v.chars().count() <= max {
        v.to_string()
    } else {
        v.chars().take(max).collect::<String>() + "…"
    }
}

/// 短名缺省：取简报首行（去 markdown 井号），截断到 20 字；空则退回 wid。
fn derive_short(brief: &str, wid: &str) -> String {
    let first = brief.lines().find(|l| !l.trim().is_empty()).unwrap_or(wid);
    let cleaned: String = first.trim().trim_start_matches('#').trim().chars().take(20).collect();
    if cleaned.is_empty() {
        wid.to_string()
    } else {
        cleaned
    }
}

// --- ToolSpec（按 W180 B1 / B2 给出，worker_status 为 B3 查询工具） ---

fn spawn_worker_spec() -> ToolSpec {
    ToolSpec {
        name: "spawn_worker".into(),
        description: "在 harness 内拉起一个 worker 会话：创建子会话（可入工作区分组）→ 命名（标题=<wid>·<短名>）→ 指定模型 → 投递自包含简报。worker 由 harness 自己的 agent-loop 驱动；看门狗按 registry 判定存活并自动重派失败项。wid 是 worker 编号（如 W101）；brief 是自包含任务简报文本。返回 {ok, sessionId, title, wid}。".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "wid":    { "type": "string", "description": "worker 编号（如 W101）" },
                "brief":  { "type": "string", "description": "自包含任务简报文本" },
                "title":  { "type": "string", "description": "会话标题短名（不含 wid· 前缀，≤20 字；缺省取简报首行/文件名）" },
                "workspace": { "type": "string", "description": "工作区/项目根目录（cwd 分组；缺省 harness 工作区）" },
                "provider":  { "type": "string", "description": "模型 provider（缺省取 harness 默认）" },
                "model":     { "type": "string", "description": "模型名（缺省取 harness 默认）" },
                "reasoning_effort": { "type": "string", "description": "推理档位（可选）" },
                "report_to": { "type": "string", "description": "回报目标会话 id：非空时在简报尾部注入完成反馈指令（写 results/<wid>-*.md + session_send_message 回执）" }
            },
            "required": ["wid", "brief"],
            "additionalProperties": false
        }),
    }
}

fn session_send_message_spec() -> ToolSpec {
    ToolSpec {
        name: "session_send_message".into(),
        description: "向 harness 内另一个会话发送消息（会话间通讯，用于多 worker 联调、交叉审计、分工协作）。target 可用会话地址（session id）或会话命名（标题/项目/工作区名；按命名指定先解析到唯一地址，命中多个返回候选清单）。content 是发送给目标会话的正文；目标会话会把它当作新一轮用户消息处理。需要对方回复时在 content 里写明要求，并告诉对方用本工具 target=<你的会话地址> 发回。发送者信息自动附带。".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "target":  { "type": "string", "description": "目标会话地址（session id）或会话命名（标题/项目名）" },
                "content": { "type": "string", "description": "发送给目标会话的消息正文" }
            },
            "required": ["target", "content"],
            "additionalProperties": false
        }),
    }
}

fn worker_status_spec() -> ToolSpec {
    ToolSpec {
        name: "worker_status".into(),
        description: "查询 harness 侧 worker registry（registry.tsv）：返回 RUNNING/DONE/FAILED 汇总；可选按 wid 过滤查看单个 worker 的会话与状态。".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "wid": { "type": "string", "description": "worker 编号（如 W101）；缺省返回全部汇总" }
            },
            "required": [],
            "additionalProperties": false
        }),
    }
}

// --- 工具壳 ---

struct WorkerTool {
    spec: ToolSpec,
    reg: Arc<WorkerRegistry>,
    exec: fn(Arc<WorkerRegistry>, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>,
}

fn worker_tool(
    spec: ToolSpec,
    reg: Arc<WorkerRegistry>,
    exec: fn(Arc<WorkerRegistry>, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>,
) -> Box<dyn Tool> {
    Box::new(WorkerTool { spec, reg, exec })
}

#[async_trait]
impl Tool for WorkerTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        (self.exec)(self.reg.clone(), args).await
    }
}

/// 三个内置工具：spawn_worker / session_send_message / worker_status。
/// 每次调用构建一组自包含状态（默认 /tmp registry 路径），适合独立/测试场景；
/// 插件挂载请用 [worker_tools_with] 共享同一个 [WorkerRegistry]。
pub fn worker_tools() -> Vec<Box<dyn celestea_core::Tool>> {
    worker_tools_with(Arc::new(WorkerRegistry::with_default_path()))
}

/// 绑定共享 [WorkerRegistry] 的三个内置工具（插件 mount 用，保证会话/队列/tsv 一致）。
pub fn worker_tools_with(reg: Arc<WorkerRegistry>) -> Vec<Box<dyn celestea_core::Tool>> {
    vec![
        worker_tool(spawn_worker_spec(), reg.clone(), spawn_worker_exec),
        worker_tool(session_send_message_spec(), reg.clone(), session_send_message_exec),
        worker_tool(worker_status_spec(), reg, worker_status_exec),
    ]
}

fn spawn_worker_exec(
    reg: Arc<WorkerRegistry>,
    args: Value,
) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> {
    Box::pin(async move { spawn_worker_impl(&reg, &args).await })
}

async fn spawn_worker_impl(reg: &WorkerRegistry, args: &Value) -> Result<Value, String> {
    // --- validate ---
    let wid = match args.get("wid").and_then(Value::as_str) {
        Some(w) => w.trim().to_string(),
        None => return Ok(contract_err("validate", "wid required")),
    };
    let brief = match args.get("brief").and_then(Value::as_str) {
        Some(b) => b.trim().to_string(),
        None => return Ok(contract_err("validate", "brief required")),
    };
    if wid.is_empty() {
        return Ok(contract_err("validate", "wid required"));
    }
    if brief.is_empty() {
        return Ok(contract_err("validate", "brief required"));
    }
    if wid.contains('\t') || wid.contains('\n') {
        return Ok(contract_err("validate", "wid must not contain tab/newline"));
    }
    // wid 唯一性：任一状态（RUNNING/DONE/FAILED）已登记即拒绝。
    if reg.get_entry(&wid).is_some() {
        return Ok(contract_err("validate", format!("wid {wid} already registered")));
    }

    let title = args.get("title").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let workspace = args.get("workspace").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let provider = args.get("provider").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let model = args.get("model").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let effort = args.get("reasoning_effort").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let report_to = args.get("report_to").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);

    // --- create 子会话 + 命名（标题 = <wid>·<短名>） ---
    let short = match title {
        Some(t) => truncate_chars(&t, 20),
        None => derive_short(&brief, &wid),
    };
    let full_title = format!("{wid}·{short}");
    let sid = reg.sessions().create(SessionSpec {
        title: full_title.clone(),
        workspace: workspace.clone(),
        model: model.clone(),
    });

    // --- 写 harness 侧 registry.tsv（extra 带 sess/ws/title/driven 等 token） ---
    let driven = reg.can_drive();
    let mut tokens: Vec<(String, String)> = vec![
        ("sess".into(), sid.clone()),
        ("title".into(), short.clone()),
        ("driven".into(), if driven { "yes" } else { "no" }.into()),
    ];
    if let Some(ws) = &workspace {
        tokens.push(("ws".into(), ws.clone()));
    }
    if let Some(p) = &provider {
        tokens.push(("provider".into(), p.clone()));
    }
    if let Some(m) = &model {
        tokens.push(("model".into(), m.clone()));
    }
    if let Some(e) = &effort {
        tokens.push(("effort".into(), e.clone()));
    }
    if let Some(r) = &report_to {
        tokens.push(("report_to".into(), r.clone()));
    }
    tokens.push(("brief".into(), truncate_chars(&sanitize_extra(&brief), 300)));
    let extra = tokens
        .iter()
        .map(|(k, v)| format!("{k}={}", sanitize_extra(v)))
        .collect::<Vec<_>>()
        .join(" ");

    let entry = WorkerEntry {
        wid: wid.clone(),
        started_at: utc_now(),
        status: WorkerStatus::Running,
        extra,
    };
    let write_result = reg.upsert(entry);

    // --- 可选后台驱动（缺 Llm/ToolRegistry/AgentLoop 任一则仅登记不驱动） ---
    let actually_driven = if driven {
        reg.drive_if_possible(&sid, &brief).await
    } else {
        false
    };

    let mut result = json!({
        "ok": true,
        "sessionId": sid,
        "title": full_title,
        "wid": wid,
        "driven": actually_driven,
    });
    if let Err(e) = write_result {
        // registry 写入失败不阻断拉起，仅告警（W180 B1(c) 尽力而为语义）。
        result["registry"] = Value::String(format!("warn: {e}"));
    }
    Ok(result)
}

fn session_send_message_exec(
    reg: Arc<WorkerRegistry>,
    args: Value,
) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> {
    Box::pin(async move { session_send_message_impl(&reg, &args).await })
}

async fn session_send_message_impl(reg: &WorkerRegistry, args: &Value) -> Result<Value, String> {
    let target = args.get("target").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let content = args.get("content").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    if target.is_empty() {
        return Ok(contract_err("validate", "target required"));
    }
    if content.is_empty() {
        return Ok(contract_err("validate", "content required"));
    }

    match reg.sessions().resolve(&target) {
        Ok(session) => {
            let from = reg.source_label();
            let sent = reg.mailbox().send(session.meta.id.clone(), content, from.clone());
            Ok(json!({
                "ok": true,
                "delivered": true,
                "queued": true,
                "target": session.meta.id,
                "sourceSession": from,
                "message_id": sent.id,
            }))
        }
        Err(ResolveError::NotFound(t)) => {
            Ok(contract_err("resolve", format!("no session matches target: {t}")))
        }
        Err(ResolveError::Ambiguous { target: t, candidates }) => {
            let cands: Vec<Value> = candidates
                .iter()
                .map(|m| json!({ "id": m.id, "title": m.title, "workspace": m.workspace, "model": m.model }))
                .collect();
            Ok(json!({
                "ok": false,
                "step": "resolve",
                "target": t,
                "candidates": cands,
            }))
        }
    }
}

fn worker_status_exec(
    reg: Arc<WorkerRegistry>,
    args: Value,
) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> {
    Box::pin(async move { worker_status_impl(&reg, &args).await })
}

async fn worker_status_impl(reg: &WorkerRegistry, args: &Value) -> Result<Value, String> {
    let wid = args
        .get("wid")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Ok(reg.summarize(wid.as_deref()))
}

// ============================================================================
// 5. WorkersPlugin — 插件挂载
// ============================================================================

/// 内置能力插件：mount 时把三个工具注册进 ToolRegistryService，并把
/// [WorkerRegistry]（registry.tsv 读写 + SessionRegistry 引用 + 驱动 seam）
/// provide 进 Context 供上层组合使用。
pub struct WorkersPlugin {
    reg: Arc<WorkerRegistry>,
}

impl WorkersPlugin {
    /// 默认 /tmp registry 路径。
    pub fn new() -> Self {
        Self::with_registry(Arc::new(WorkerRegistry::with_default_path()))
    }

    /// 共享外部构造的 registry（测试 / 组合场景）。
    pub fn with_registry(reg: Arc<WorkerRegistry>) -> Self {
        Self { reg }
    }

    /// 自定义 registry.tsv 落盘路径。
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self::with_registry(Arc::new(WorkerRegistry::new(path)))
    }

    pub fn registry(&self) -> &Arc<WorkerRegistry> {
        &self.reg
    }
}

impl Default for WorkersPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl Plugin for WorkersPlugin {
    fn name(&self) -> &'static str {
        "celestea-workers"
    }

    fn mount(&self, ctx: &mut Context) {
        // 注入后台驱动 seam（缺任一则 spawn 仅登记不驱动）。
        let llm = ctx.get::<LlmService>();
        let tools = ctx.get::<ToolRegistryService>();
        let agent_loop = ctx.get::<AgentLoopService>().map(|s| s.0.clone());
        self.reg.attach_drivers(llm, tools, agent_loop);

        // provide WorkerRegistry 服务（get::<WorkerRegistryService>() 取回 Arc）。
        ctx.provide(WorkerRegistryService(self.reg.clone()));

        // ToolRegistryService 只暴露不可变 Deref（Arc<dyn ToolRegistry>），挂载后
        // 无法向宿主已共享的注册表注入工具；按 core 的 patch 语义（后 provide 替换
        // 先 provide），provide 一个 builtin + workers 三工具的组合注册表，使 agent
        // 的工具面包含这三个内置能力。
        let mut combined = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            combined.register(tool);
        }
        for tool in worker_tools_with(self.reg.clone()) {
            combined.register(tool);
        }
        ctx.provide(ToolRegistryService(Arc::new(combined)));
    }
}


// ============================================================================
// 7. WatchdogPlugin——看门狗后台巡检（W186）
// ============================================================================

/// 看门狗插件：mount 时（若尚未启动）spawn 一个 tokio 后台巡检循环，
/// 按配置 interval 周期性地跑一轮 [Watchdog::tick]。
///
/// 缺省使用默认配置（/server-center/runtime/worker-exec 结果与日志目录，
/// interval 30s / grace 10min / max_retries 2）；可用 [WatchdogPlugin::with_config]
/// 覆盖，或 [WatchdogPlugin::with_for_test] 指向临时目录。
pub struct WatchdogPlugin {
    watchdog: Arc<Watchdog>,
    interval: Duration,
}

impl WatchdogPlugin {
    /// 默认 registry（/tmp registry.tsv）+ 默认看门狗配置。
    pub fn new() -> Self {
        Self::with_registry(Arc::new(WorkerRegistry::with_default_path()))
    }

    /// 绑定外部 registry + 默认配置（组合/测试场景）。
    pub fn with_registry(reg: Arc<WorkerRegistry>) -> Self {
        Self::with(reg, WatchdogConfig::default())
    }

    /// 自定义 registry + 任意配置。
    pub fn with(reg: Arc<WorkerRegistry>, config: WatchdogConfig) -> Self {
        let interval = config.interval;
        Self { watchdog: Arc::new(Watchdog::new(reg, config)), interval }
    }

    pub fn watchdog(&self) -> &Arc<Watchdog> {
        &self.watchdog
    }
}

impl Default for WatchdogPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl Plugin for WatchdogPlugin {
    fn name(&self) -> &'static str {
        "celestea-workers-watchdog"
    }

    fn mount(&self, ctx: &mut Context) {
        // 共享同一 WorkerRegistry（若上层已挂 WorkersPlugin，provide 会替换）。
        ctx.provide(WorkerRegistryService(self.watchdog.registry().clone()));

        let wd = self.watchdog.clone();
        let interval = self.interval;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(e) = wd.tick().await {
                    eprintln!("[celestea-workers] watchdog tick failed: {e}");
                }
            }
        });
    }
}


// 6. 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use celestea_agent_loop::DefaultAgentLoop;
    use celestea_core::{
        AgentConfig, Llm, LlmError, LlmStream, Message, ModelRequest, SessionEvent, SessionLog,
        StreamEvent, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolSpec,
    };
    use futures_util::stream;
    use futures_util::StreamExt;
    use serde_json::json;
    use std::collections::VecDeque;
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

