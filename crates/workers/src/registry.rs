//! celestea-workers：WorkerRegistry — registry.tsv 原子读写 + 会话引用 + 驱动 seam（W185）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use celestea_core::{
    AgentError, AgentLoop, AgentLoopService, Context, LlmService, SessionEvent, SessionLog,
    SessionService, ToolRegistryService,
};
use celestea_session::{SessionMailbox, SessionRegistry};
use serde_json::{json, Value};
use tokio::sync::Notify;
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
    /// W232: per-session stop signals for the mailbox event-loop drivers.
    /// stop_driver(sid) notifies the waiter so a driver blocked in
    /// mailbox.recv exits as soon as its session is removed/purged (W224 的
    /// release_session 清理路径调用它)。Entry 由 driver_stop 惰性创建、由
    /// stop_driver 移除——不残留已停止会话的 Notify。
    stops: Mutex<HashMap<String, Arc<Notify>>>,
    /// W232: registry 写 seq，用于 tmp 文件名去重——驱动循环的状态标注与
    /// 看门狗的整表重写并发时，各自写各自唯一的 tmp 文件再 rename，
    /// 避免同 pid 下共享 tmp 路径的写交织（tmp+rename 原子替换语义不变）。
    write_seq: AtomicU64,
    /// W235: 回执协议的报告文件基目录（相对路径时相对进程 CWD 解析）。
    /// 缺省 "results"；测试可经 set_results_dir 注入 tempdir，避免污染
    /// 测试进程 CWD 下的 results/。
    results_dir: RwLock<PathBuf>,
    /// W234: 本进程 pid —— 构造时记下，upsert 写行时随 extra 的 proc token
    /// 落盘。/tmp registry.tsv 跨进程共享（残留旧行 sess 会因 SessionRegistry
    /// next_id 归零而撞车），行归属以 proc 标记区分；旧行无 proc 视为他进程。
    pid: u32,
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
            stops: Mutex::new(HashMap::new()),
            write_seq: AtomicU64::new(0),
            results_dir: RwLock::new(PathBuf::from("results")),
            pid: std::process::id(),
        }
    }

    pub fn with_default_path() -> Self {
        Self::new(Self::default_tsv_path())
    }

    pub fn tsv_path(&self) -> &Path {
        &self.path
    }

    /// 本进程 pid（registry 行的 proc 归属标记）。
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// 行是否由本进程写入（无 proc 的旧行视为其他进程 → false）。
    fn is_own(&self, entry: &WorkerEntry) -> bool {
        entry.proc_id() == Some(self.pid)
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

    /// W235: 回执报告文件的基目录（缺省 "results"，相对进程 CWD）。
    pub fn results_dir(&self) -> PathBuf {
        self.results_dir
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| PathBuf::from("results"))
    }

    /// W235: 覆盖报告文件基目录（测试注入 tempdir 用，隔离 CWD 副作用）。
    pub fn set_results_dir(&self, dir: impl Into<PathBuf>) {
        if let Ok(mut g) = self.results_dir.write() {
            *g = dir.into();
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
        let seq = self.write_seq.fetch_add(1, Ordering::Relaxed);
        let tmp = self
            .path
            .with_file_name(format!("{file_name}.tmp-{}-{seq}", std::process::id()));

        let mut content = String::new();
        for e in entries {
            content.push_str(&e.serialize_line());
            content.push('\n');
        }
        std::fs::write(&tmp, content)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// 按 wid upsert（存在则替换整行，否则追加）。写入前给行打上本进程
    /// proc 标记（W234）：行归属 = 写它的进程；其余进程的行原样保留。
    pub fn upsert(&self, entry: WorkerEntry) -> std::io::Result<()> {
        let mut entry = entry;
        entry.set_proc(self.pid);
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
    /// W234: 视图只统计本进程行——其他进程（含无 proc 的旧残留行）不进
    /// by_status/by_state/workers，也不会被 wid 过滤命中，避免跨进程残留行
    /// 污染 worker_status 的状态视图。
    pub fn summarize(&self, filter: Option<&str>) -> Value {
        let entries: Vec<WorkerEntry> = self
            .read_entries()
            .into_iter()
            .filter(|e| self.is_own(e))
            .collect();
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
        // W232 状态模型：RUNNING 行再按 extra 里的 state 标注细分（in-turn /
        // idle / 未标注），让 worker_status 能看到驱动循环的真实阶段。
        let in_turn = entries
            .iter()
            .filter(|e| e.status == WorkerStatus::Running && e.state().as_deref() == Some("in-turn"))
            .count();
        let idle = entries
            .iter()
            .filter(|e| e.status == WorkerStatus::Running && e.state().as_deref() == Some("idle"))
            .count();
        let plain = running - in_turn - idle;
        json!({
            "ok": true,
            "total": entries.len(),
            "by_status": {
                "RUNNING": running,
                "DONE": done,
                "FAILED": failed,
            },
            "by_state": {
                "in-turn": in_turn,
                "idle": idle,
                "running": plain,
            },
            "workers": entries.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
        })
    }

    /// 若驱动 seam 齐备且会话存在，tokio 后台拉起该 worker 的 mailbox 事件
    /// 循环驱动（W232）：先跑一轮 brief turn（原行为），随后阻塞在
    /// mailbox.recv(sid) 上，每条到达的消息以 content 作为新一轮用户输入跑
    /// run_turn，再回到等待——同一 worker 的轮次天然串行。任务随会话存活，
    /// 直到会话被移除/purge（W224 的 release_session 会 stop_driver）或
    /// abort_all 关闭时退出。返回是否真的启动了后台任务。
    pub async fn drive_if_possible(self: &Arc<Self>, sid: &str, brief: &str) -> bool {
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
        let reg = Arc::clone(self);
        let stop = self.driver_stop(&sid);

        // Spawn into the tracked JoinSet instead of discarding the handle, so
        // background driver tasks can be observed, reaped on completion, and
        // aborted on shutdown (W188)。W232 起任务从"单轮"升级为 mailbox 事件
        // 循环：JoinSet 槽位随 worker 存活，prune_completed 只收割真正结束
        // （会话被移除/purge 后退出）的任务（F1 逻辑保持）。
        let mut guard = self.background.lock().unwrap_or_else(|p| p.into_inner());
        guard.spawn(async move {
            reg.run_driver_loop(&sid, &loop_, &ctx, &brief, &stop).await;
        });
        true
    }

    /// mailbox 事件循环主体（后台任务内运行）：brief turn → mailbox.recv 循环。
    /// 退出条件：会话被移除（SessionRegistry::remove）——每轮等待前自检一次、
    /// stop Notify 被触发（release_session / abort_all 路径）——select 跳出。
    /// 退出时顺手清理自己的 stop 表项，避免 stops 表残留。
    async fn run_driver_loop(
        &self,
        sid: &str,
        loop_: &Arc<dyn AgentLoop>,
        ctx: &Context,
        brief: &str,
        stop: &Notify,
    ) {
        // 会话在任务真正开跑前就被移除（如看门狗已裁决）→ 直接退出，不跑孤儿轮。
        if self.sessions.get(sid).is_none() {
            self.stop_driver(sid);
            return;
        }

        // 第一轮：简报 brief turn（原行为），状态标注 in-turn。
        self.set_worker_state(sid, "in-turn").await;
        let brief_result = loop_.run_turn(ctx, brief).await;
        if let Err(e) = &brief_result {
            eprintln!("[celestea-workers] {sid} background turn failed: {e}");
        }
        // W235: brief turn 结束后机械执行回执协议（Ok/Err 都执行，不依赖模型
        // 遵从）。协议只在 brief turn 后跑这一次——mailbox 消息驱动的轮次
        // 不重复执行（任务为 brief 驱动型）。
        self.execute_report_receipt(sid, brief, &brief_result);

        // 进入 mailbox 事件循环：每条消息一个串行 turn。
        loop {
            if self.sessions.get(sid).is_none() {
                break; // 会话已被移除 → 退出（stop 表项清理见尾）
            }
            self.set_worker_state(sid, "idle").await;
            tokio::select! {
                msg = self.mailbox.recv(sid) => {
                    // 唤醒瞬间会话可能刚被 release（remove+purge）：再自检一次，
                    // 已移除则丢弃该条消息并退出。
                    if self.sessions.get(sid).is_none() {
                        break;
                    }
                    self.set_worker_state(sid, "in-turn").await;
                    if let Err(e) = loop_.run_turn(ctx, &msg.content).await {
                        eprintln!("[celestea-workers] {sid} mailbox turn failed: {e}");
                    }
                }
                _ = stop.notified() => break,
            }
        }
        // 退出清理：移除本会话的 stop 表项（同时唤醒同 sid 的其他等待者——不存在）。
        self.stop_driver(sid);
    }

    /// W235 回执协议：brief turn 结束后机械执行（Ok/Err 均执行，不依赖模型
    /// 遵从）。仅当本进程 tsv 行 extra 带非空 report_to token 时生效，否则
    /// 直接返回（不写文件不回执）。协议 = 写 Markdown 报告（<results 基目录>/
    /// <wid>-<short>.md；目录不存在则创建；写失败不 panic，回执带 warn）+
    /// mailbox 回执（content 一行 WORKER_<wid>_DONE/FAILED，from=本 worker
    /// sid）。W241：回执尾部追加 worker 会话日志最后一条 AssistantMessage
    /// 的文本摘要（"答复: " 段，截断 ~200 字符、换行折叠成空格；无则不带）。
    /// 本方法只在 brief turn 后被调用一次，mailbox 消息驱动的轮次
    /// 不重复执行（任务为 brief 驱动型）。
    fn execute_report_receipt(
        &self,
        sid: &str,
        brief: &str,
        turn_result: &Result<(), AgentError>,
    ) {
        // 按 sess 反查本进程行；查不到（如测试直连会话不经 tsv）→ 静默跳过。
        let Some(wid) = self.find_wid_for_sess(sid) else { return };
        let Some(entry) = self.get_entry(&wid) else { return };
        let Some(report_to) = entry.get_extra("report_to").filter(|v| !v.is_empty()) else { return };
        // <short> 取本行 extra 的 title token；缺失退回 wid。
        let short = entry
            .get_extra("title")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| wid.clone());

        // 文件名消毒：wid/short 中 [A-Za-z0-9._-] 之外的字符一律替换为 '_'
        //（复用/仿照 crates/session::persistent::file_name_for 的消毒语义），
        // 防路径穿越；回执里的报告路径用消毒后的 stem，与实际落盘文件一致。
        let stem = format!("{}-{}", sanitize_file_stem(&wid), sanitize_file_stem(&short));
        let rel = format!("results/{stem}.md");
        let base = self.results_dir();
        let abs = base.join(format!("{stem}.md"));

        let (ok, err_summary) = match turn_result {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e.to_string()),
        };
        let status = if ok { "OK".to_string() } else { format!("ERR: {err_summary}") };
        let body = render_worker_report(
            &wid,
            &short,
            &status,
            &entry.started_at,
            brief,
            &rel,
            self.sessions.get(sid).map(|s| s.log.clone() as Arc<dyn SessionLog>),
        );

        // 写报告文件：目录不存在则创建；失败不 panic，回执里带 warn。
        let mut warn = String::new();
        let write_result = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&base)?;
            std::fs::write(&abs, &body)
        })();
        if let Err(e) = write_result {
            warn = format!(" warn: {e}");
        }

        // 回执：一行，宿主侧按 WORKER_<wid>_DONE / WORKER_<wid>_FAILED 前缀解析；
        // report_to 指向的会话由 mailbox 排队（宿主 run_turn drain 已由 W232 实现）。
        // W241：回执尾部追加 worker 最终答复 —— 会话日志最后一条
        // AssistantMessage 的文本摘要（截断 ~200 字符、换行折叠成空格），
        // 标注 "答复: "；无 assistant 记录则不带该段（Ok/Err 分支同理）。
        let answer = self
            .sessions
            .get(sid)
            .and_then(|s| last_assistant_summary(&s.log.events()))
            .map(|text| format!(" 答复: {text}"))
            .unwrap_or_default();
        let content = if ok {
            format!("WORKER_{wid}_DONE OK 报告 {rel}（完成）{warn}{answer}")
        } else {
            format!("WORKER_{wid}_FAILED ERR {err_summary} 报告 {rel}（失败：{err_summary}）{warn}{answer}")
        };
        self.mailbox.send(report_to, content, sid.to_string());
    }

    /// 取（或惰性创建）会话 sid 的停止信号，供事件循环 select 退出。
    fn driver_stop(&self, sid: &str) -> Arc<Notify> {
        let mut guard = self.stops.lock().unwrap_or_else(|p| p.into_inner());
        guard.entry(sid.to_string()).or_insert_with(|| Arc::new(Notify::new())).clone()
    }

    /// 停止会话 sid 的 mailbox 事件循环驱动：notify 等待者并移除表项。
    /// W224 的清理路径（watchdog release_session：sessions().remove + mailbox().purge）
    /// 现在必须配套调用本方法，否则驱动任务会一直阻塞在 recv 上。
    pub fn stop_driver(&self, sid: &str) {
        let removed = self
            .stops
            .lock()
            .map(|mut g| g.remove(sid))
            .unwrap_or(None);
        if let Some(n) = removed {
            n.notify_waiters();
        }
    }

    /// 按 sess=<sid> 反查 wid（状态标注需要 wid 定位 registry 行）。
    /// W234: 只匹配本进程写入的行——跨进程残留旧行的 sess 会撞车（两个进程的
    /// 首个会话都是 session-0），旧行无 proc 一律视为其他进程跳过，
    /// 状态 token 不再写错行。
    fn find_wid_for_sess(&self, sid: &str) -> Option<String> {
        self.read_entries()
            .into_iter()
            .find(|e| self.is_own(e) && e.get_extra("sess").as_deref() == Some(sid))
            .map(|e| e.wid)
    }

    /// W232 状态模型：把 registry 里 sid 对应 RUNNING 行的 extra state token
    /// 更新为 in-turn / idle。仅当行仍是 RUNNING 时写入——驱动任务绝不把
    /// DONE/FAILED 行复活成 RUNNING（看门狗是唯一的状态裁决方）。wid 查不到
    /// （如测试直连会话不经 tsv）则静默跳过。
    async fn set_worker_state(&self, sid: &str, state: &str) {
        let Some(wid) = self.find_wid_for_sess(sid) else { return };
        let mut entries = self.read_entries();
        let Some(entry) = entries.iter_mut().find(|e| e.wid == wid) else { return };
        if entry.status != WorkerStatus::Running {
            return; // 已 DONE/FAILED：驱动不覆盖看门狗裁决
        }
        entry.set_extra_state(Some(state));
        let _ = self.write_entries(&entries);
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

    /// W248 shutdown path, sync half: notify every session stop signal (so
    /// driver loops blocked in mailbox.recv exit at their next select) and
    /// abort every tracked background driver task. Skips the async join — used
    /// by Runtime::drop, which cannot await; tokio drops the aborted task
    /// futures (and their captured Arcs) promptly on cancellation.
    pub fn abort_all_now(&self) {
        let notified: Vec<Arc<Notify>> = {
            let mut guard = self.stops.lock().unwrap_or_else(|p| p.into_inner());
            guard.drain().map(|(_, n)| n).collect()
        };
        for n in notified {
            n.notify_waiters();
        }
        let mut guard = self.background.lock().unwrap_or_else(|p| p.into_inner());
        guard.abort_all();
    }

    /// Wait for every aborted driver task to finish unwinding (join). Only
    /// meaningful after [WorkerRegistry::abort_all_now]; used by Runtime::shutdown
    /// so it can guarantee the driver set is fully reaped before returning.
    pub async fn join_drivers(&self) {
        let mut guard = self.background.lock().unwrap_or_else(|p| p.into_inner());
        while guard.join_next().await.is_some() {}
    }

    /// Abort every tracked background driver task and clear the set
    /// (shutdown / cancel path). Already-finished results are dropped.
    /// W232: 先通知所有会话的停止信号（让阻塞在 mailbox.recv 的循环退出），
    /// 再 abort + join 兜底收割。W248: sync 半部分在 abort_all_now，join 在
    /// join_drivers（Runtime::shutdown 复用；Drop 只跑 sync 半部分）。
    pub async fn abort_all(&self) {
        self.abort_all_now();
        self.join_drivers().await;
    }
}

/// W235: 文件名 stem 消毒 —— [A-Za-z0-9._-] 之外的字符一律替换为 '_'
///（复用 crates/session::persistent::file_name_for 的消毒语义，但不加
/// .jsonl 后缀），防路径穿越；空结果退回 "worker"，保证文件名永不为空。
pub(crate) fn sanitize_file_stem(s: &str) -> String {
    let name: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if name.is_empty() { "worker".to_string() } else { name }
}

/// W235: 渲染 worker 完成报告（Markdown）：wid / title / status / started_at /
/// 报告路径 / 简报摘要（前 200 字符）/ 会话尾记录（最近 20 条事件渲染成
/// `- role: text` 列表）。
fn render_worker_report(
    wid: &str,
    short: &str,
    status: &str,
    started_at: &str,
    brief: &str,
    report_path: &str,
    log: Option<Arc<dyn SessionLog>>,
) -> String {
    let brief_summary: String = brief.trim().chars().take(200).collect();
    let mut out = format!(
        "# Worker {wid} 完成报告\n\n- wid: {wid}\n- title: {short}\n- status: {status}\n- started_at: {started_at}\n- report: {report_path}\n\n## 简报摘要\n\n{brief_summary}\n\n## 会话尾记录\n\n"
    );
    match log {
        Some(log) => {
            const TAIL: usize = 20;
            let events = log.events();
            let skip = events.len().saturating_sub(TAIL);
            let mut any = false;
            for e in events.iter().skip(skip) {
                if let Some(line) = render_event_line(e) {
                    out.push_str(&line);
                    out.push('\n');
                    any = true;
                }
            }
            if !any {
                out.push_str("（无记录）\n");
            }
        }
        None => out.push_str("（无记录）\n"),
    }
    out
}

/// W241: 会话事件流里最后一条 AssistantMessage 的文本摘要（回执 "答复: " 段）：
/// 截断 ~200 字符、换行折叠为空格；没有任何 assistant 记录返回 None。
pub(crate) fn last_assistant_summary(events: &[SessionEvent]) -> Option<String> {
    let text = events.iter().rev().find_map(|e| match e {
        SessionEvent::AssistantMessage { text } => Some(text.as_str()),
        _ => None,
    })?;
    Some(text.chars().take(200).collect::<String>().replace('\n', " "))
}

/// W235: SessionEvent → `- role: text` 一行（报告会话尾记录用）。
/// 映射参照 tools.rs 既有事件映射的简单分类：UserMessage / AssistantMessage /
/// ToolCall / ToolResult；TurnStart/TurnEnd 渲染为 turn 标记行。
fn render_event_line(e: &SessionEvent) -> Option<String> {
    let one_line = |s: &str| s.chars().take(200).collect::<String>().replace('\n', " ");
    match e {
        SessionEvent::UserMessage { text } => Some(format!("- user: {}", one_line(text))),
        SessionEvent::AssistantMessage { text } => Some(format!("- assistant: {}", one_line(text))),
        SessionEvent::ToolCall { name, args, .. } => {
            Some(format!("- tool_call {name}: {}", one_line(&args.to_string())))
        }
        SessionEvent::ToolResult { id, value, error } => Some(match (value, error) {
            (Some(v), _) => format!("- tool_result {id}: {}", one_line(&v.to_string())),
            (_, Some(err)) => format!("- tool_result {id}: error {}", one_line(err)),
            _ => format!("- tool_result {id}"),
        }),
        SessionEvent::TurnStart { id } => Some(format!("- turn: start {id}")),
        SessionEvent::TurnEnd { id, .. } => Some(format!("- turn: end {id}")),
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

