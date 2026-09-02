//! celestea-workers 看门狗（W186）—— Worker 巡检 + 自动重派。
//!
//! 语义完全复用 dsh 看门狗状态机（W180 B3），但全部在 harness 进程内自洽：
//! 读 harness 侧 registry.tsv → 对 RUNNING 行抽 sess=<id> → 查 SessionRegistry
//! 会话存活：
//!
//! - 运行中（仍有进行中的 turn 或 mailbox 有待处理消息）→ 保持 RUNNING；
//! - 已结束且有交付物（results/<wid>-*.md 存在）→ DONE；
//! - 已结束且无交付物 → anomaly：宽限期（新派 < grace 不重派）→
//!   retries < max_retries(默认2) → 自动重派（用 extra 里的 brief 重建会话+驱动，
//!   retries+1，写 watcher.log/alerts.log）→ 否则 FAILED。
//!
//! registry 重写保持 tmp+rename 原子替换（复用 WorkerRegistry::write_entries）；
//! 坏行由 WorkerEntry::parse_line 跳过；交付物探测 IO 错误记 watcher.log 本轮跳过。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use celestea_core::{SessionEvent, SessionLog};

use celestea_session::{Session, SessionSpec};
use crate::{WorkerEntry, WorkerRegistry, WorkerStatus};

// ==== 时间戳反向解析（format_utc 的逆，供宽限期判定） ====

/// 解析 "%Y-%m-%d_%H:%M:%S"（UTC，format_utc 的逆）。失败返回 None。
pub fn parse_utc(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() != 19 { return None; }
    let (date, time) = s.split_once('_')?;
    let (y, rest) = date.split_once('-')?;
    let (m, d) = rest.split_once('-')?;
    let (hh, rest) = time.split_once(':')?;
    let (mm, ss) = rest.split_once(':')?;
    let year: i64 = y.parse().ok()?;
    let month: i64 = m.parse().ok()?;
    let day: i64 = d.parse().ok()?;
    let h: i64 = hh.parse().ok()?;
    let min: i64 = mm.parse().ok()?;
    let sec: i64 = ss.parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > 31 || h > 23 || min > 59 || sec > 60 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3_600 + min * 60 + sec)
}

// ============================================================================
// WatchdogConfig 与日志路径
// ============================================================================

/// 看门狗配置。interval 默认 30s / grace 默认 10min / max_retries 默认 2。
#[derive(Debug, Clone)]
pub struct WatchdogConfig {
    /// 巡检周期。
    pub interval: Duration,
    /// 交付物判定目录（results/<wid>-*.md）。
    pub results_dir: PathBuf,
    /// 自动重派上限（extra 里 retries < max_retries 才重派）。
    pub max_retries: u32,
    /// 新派宽限（started_at 距今 < grace 不重派）。
    pub grace: Duration,
    /// watcher.log 路径。
    pub watcher_log: PathBuf,
    /// alerts.log 路径。
    pub alerts_log: PathBuf,
}

impl WatchdogConfig {
    /// 面向测试的临时配置：结果/日志目录都在 prefix 下，interval 缩短。
    pub fn for_test(prefix: &Path) -> Self {
        Self {
            interval: Duration::from_millis(20),
            results_dir: prefix.join("results"),
            max_retries: 2,
            grace: Duration::from_secs(600),
            watcher_log: prefix.join("watcher.log"),
            alerts_log: prefix.join("alerts.log"),
        }
    }
}

// ============================================================================
// WatchAction——本轮对单个 worker 的裁决（供巡检循环与单测观测）
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchAction {
    /// 保持 RUNNING（运行中）。
    KeepRunning { wid: String },
    /// 已结束且有交付物 → DONE。
    MarkDone { wid: String },
    /// 宽限期内 anomaly，暂不重派。
    GraceDeferred { wid: String },
    /// 自动重派成功。
    Respawned { wid: String, retries: u32 },
    /// retries 耗尽 → FAILED。
    MarkFailed { wid: String },
    /// 交付物探测 IO 错误，本轮跳过。
    ProbeError { wid: String },
}

impl WatchAction {
    pub fn kind(&self) -> &'static str {
        match self {
            WatchAction::KeepRunning { .. } => "keep-running",
            WatchAction::MarkDone { .. } => "done",
            WatchAction::GraceDeferred { .. } => "grace-deferred",
            WatchAction::Respawned { .. } => "respawned",
            WatchAction::MarkFailed { .. } => "failed",
            WatchAction::ProbeError { .. } => "probe-error",
        }
    }
}


// ============================================================================
// 会话存活 / 交付物判定（纯函数，可单测）
// ============================================================================

/// 会话是否仍在产出：mailbox 有待处理消息（有活要干）或日志里有进行中的 turn
/// （TurnStart 未配对的 TurnEnd）。
pub fn session_alive(session: &Session, _pending_mail: usize) -> bool {
    // F3 (W224): 仅当「有进行中 turn」时才算存活。原实现把 pending_mail > 0 一律判为
    // 存活，而生产 agent 循环从不消费 mailbox（W222 F3），导致已结束的 worker 被永久
    // 钉在 RUNNING —— tick 永远 KeepRunning，走不到 anomaly / DONE / FAILED 判定。
    // 修正后：无进行中 turn 的 pending 邮件不视为存活（无消费者的消息随 F2 的
    // sessions().remove + mailbox().purge 清理）；有进行中 turn 时会话本身即存活，
    // 此时队列里还有未处理消息则更是"有活要干"（由 in_progress 覆盖）。
    let events = session.log.events();
    let starts = events
        .iter()
        .filter(|e| matches!(e, SessionEvent::TurnStart { .. }))
        .count();
    let ends = events
        .iter()
        .filter(|e| matches!(e, SessionEvent::TurnEnd { .. }))
        .count();
    starts > ends
}

/// 交付物判定：results/<wid>-*.md 存在。IO 错误返回 Err 交给上层记日志跳过本轮。
pub fn has_deliverable(results_dir: &Path, wid: &str) -> io::Result<bool> {
    let rd = fs::read_dir(results_dir)?;
    for entry in rd {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.starts_with(wid) && name.ends_with(".md") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 宽限期判定：started_at 解析成功且 now - started < grace → true。
/// 解析失败不视为宽限（保守：允许重派）。
pub fn in_grace(started_at: &str, now: i64, grace_secs: i64) -> bool {
    match parse_utc(started_at) {
        Some(t) => now >= t && now - t < grace_secs,
        None => false,
    }
}


// ============================================================================
// 看门狗主循环逻辑（tick 一次 = 一轮巡检）
// ============================================================================

enum TickOutcome {
    Action(WatchAction),
    ProbeError(WatchAction),
}

/// 看门狗巡检服务：持有 WorkerRegistry（会话/驱动 seam/tsv 原子读写）+ 配置。
/// tick() 执行一轮巡检并返回每条裁决，供巡检循环观测。
pub struct Watchdog {
    reg: Arc<WorkerRegistry>,
    config: WatchdogConfig,
}

impl Watchdog {
    pub fn new(reg: Arc<WorkerRegistry>, config: WatchdogConfig) -> Self {
        Self { reg, config }
    }

    pub fn config(&self) -> &WatchdogConfig {
        &self.config
    }

    pub fn registry(&self) -> &Arc<WorkerRegistry> {
        &self.reg
    }

    fn log_appender(path: &Path, line: &str) {
        if let Some(p) = path.parent() {
            let _ = fs::create_dir_all(p);
        }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }
    }

    fn log_watcher(&self, line: &str) {
        Self::log_appender(&self.config.watcher_log, line);
    }

    fn log_alert(&self, line: &str) {
        Self::log_appender(&self.config.alerts_log, line);
    }

    /// F2 (W224): 会话结束时释放 SessionRegistry 里的会话（连同其日志）与
    /// SessionMailbox 里未消费的消息队列，避免已结束 worker 的会话/日志/入队消息
    /// 在进程内无界累积（W222 F2）。仅在判定会话已结束（无进行中 turn，见 F3 的
    /// [session_alive]）后调用 —— 避免误杀仍有进行中 turn 的存活 worker。
    fn release_session(&self, sess: &str) {
        self.reg.sessions().remove(sess);
        self.reg.mailbox().purge(sess);
    }

    /// 一轮巡检：读 registry → 对 RUNNING 行逐一裁决 → 原子重写 → 返回裁决清单。
    pub async fn tick(&self) -> Result<Vec<WatchAction>, io::Error> {
        let mut entries = self.reg.read_entries();
        let mut actions = Vec::new();
        let now = crate::utc_now();

        for entry in entries.iter_mut() {
            if entry.status != WorkerStatus::Running {
                continue; // 跳过 DONE/FAILED
            }
            match self.tick_one(entry, &now).await {
                TickOutcome::Action(a) => actions.push(a),
                TickOutcome::ProbeError(a) => actions.push(a),
            }
        }

        // 原子重写（tmp+rename 由 WorkerRegistry::write_entries 保证）。
        self.reg.write_entries(&entries)?;
        Ok(actions)
    }

    async fn tick_one<'a>(&'a self, entry: &'a mut WorkerEntry, now_str: &str) -> TickOutcome {
        // --- 抽 sess=<id> ---
        let Some(sess) = entry.get_extra("sess") else {
            // 无会话 id：按"会话结束无交付物"处理，走 anomaly 判定。
            return self.decide_anomaly(entry, now_str).await;
        };

        // --- 查 SessionRegistry 会话存活 ---
        let session = self.reg.sessions().get(&sess);
        let live = match &session {
            Some(s) => session_alive(s, self.reg.mailbox().pending(&sess)),
            None => false, // 会话已不在 → 视为结束
        };

        if live {
            self.log_watcher(&format!("[{now_str}] {wid} keep-running sess={sess}", wid = entry.wid));
            return TickOutcome::Action(WatchAction::KeepRunning { wid: entry.wid.clone() });
        }

        // --- 会话已结束：先判交付物（探测 IO 错 → 记日志跳过本轮） ---
        let deliverable = match has_deliverable(&self.config.results_dir, &entry.wid) {
            Ok(d) => d,
            Err(e) => {
                self.log_watcher(&format!("[{now_str}] {} deliverable probe IO error: {e}; skip", entry.wid));
                self.log_alert(&format!("[{now_str}] {} probe-io-error: {e}", entry.wid));
                return TickOutcome::ProbeError(WatchAction::ProbeError { wid: entry.wid.clone() });
            }
        };

        if deliverable {
            entry.status = WorkerStatus::Done;
            // F2 (W224): 会话已结束（无进行中 turn，见 F3）→ 释放会话与 mailbox 队列，
            // 终止 DONE 行会话/日志/消息的永久留存（W222 F2）。
            self.release_session(&sess);
            self.log_watcher(&format!("[{now_str}] {} -> DONE (deliverable present)", entry.wid));
            return TickOutcome::Action(WatchAction::MarkDone { wid: entry.wid.clone() });
        }

        // --- 结束且无交付物 → anomaly 判定 ---
        self.decide_anomaly(entry, now_str).await
    }
}


impl Watchdog {
    async fn decide_anomaly<'a>(&'a self, entry: &'a mut WorkerEntry, now_str: &str) -> TickOutcome {
        let wid = entry.wid.clone();
        // F2 (W224): 记录当前会话 id，供终态（FAILED / 重派换新会话）时释放；
        // 宽限期（GraceDeferred）内保留，保持短暂窗口内会话仍可被消息寻址。
        let old_sess = entry.get_extra("sess");
        let now_secs = parse_utc(now_str).unwrap_or(0);

        // --- 宽限期：新派 < grace 不重派 ---
        if in_grace(&entry.started_at, now_secs, self.config.grace.as_secs() as i64) {
            self.log_watcher(&format!(
                "[{now_str}] {wid} anomaly (ended, no deliverable), in grace, deferred (started {})",
                entry.started_at
            ));
            self.log_alert(&format!(
                "[{now_str}] {wid} anomaly: session ended without deliverable; in grace (retries={})",
                entry.count_retries()
            ));
            return TickOutcome::Action(WatchAction::GraceDeferred { wid });
        }

        // --- retries 判定 ---
        let retries = entry.count_retries();
        if retries < self.config.max_retries {
            // 自动重派：用 extra 里的 brief 重建会话 + 驱动
            let Some(brief) = entry.get_extra("brief") else {
                // 无简报 → 无法重派 → FAILED（W180 B3(c) 错误模型）
                entry.status = WorkerStatus::Failed;
                // F2 (W224): 终态释放会话/mailbox（会话已结束，见 F3）。
                if let Some(old) = &old_sess {
                    self.release_session(old);
                }
                self.log_watcher(&format!("[{now_str}] {wid} -> FAILED (no brief to respawn)"));
                self.log_alert(&format!("[{now_str}] {wid} FAILED: no brief to auto-respawn"));
                return TickOutcome::Action(WatchAction::MarkFailed { wid });
            };

            // F2 (W224): 先释放旧会话（已结束，见 F3）再建新会话 —— 否则每次自动重派
            // 都会永久留存一个旧会话（W222 F2 证据：重派新建会话、旧会话继续留存）。
            if let Some(old) = &old_sess {
                self.release_session(old);
            }
            // 重建会话（标题沿用原 wid·短名）
            let title = entry.get_extra("title").unwrap_or_else(|| wid.clone());
            let sid = self.reg.sessions().create(SessionSpec {
                title: format!("{wid}·{title}"),
                workspace: entry.get_extra("ws"),
                model: entry.get_extra("model"),
            });

            // 更新：新 sess + retries+1 + started_at 刷新，保持 brief；可以驱动。
            entry.started_at = now_str.to_string();
            entry.status = WorkerStatus::Running;
            let new_retries = retries + 1;
            entry.set_extra_sess(&sid);
            entry.set_extra_retries(new_retries);
            entry.set_extra_driven(self.reg.can_drive());

            self.log_watcher(&format!(
                "[{now_str}] {wid} respawn #{new_retries} sess={sid} (brief from extra)"
            ));
            self.log_alert(&format!(
                "[{now_str}] {wid} AUTO-RESPAWN #{new_retries} sess={sid} (ended without deliverable)"
            ));

            // 驱动新会话（async）。
            self.reg.drive_if_possible(&sid, &brief).await;
            return TickOutcome::Action(WatchAction::Respawned { wid, retries: new_retries });
        }

        // --- retries 耗尽 → FAILED ---
        entry.status = WorkerStatus::Failed;
        // F2 (W224): 终态释放会话/mailbox（会话已结束，见 F3）。
        if let Some(old) = &old_sess {
            self.release_session(old);
        }
        self.log_watcher(&format!("[{now_str}] {wid} -> FAILED (retries exhausted at {retries})"));
        self.log_alert(&format!(
            "[{now_str}] {wid} FAILED: retries exhausted ({retries} >= max {})",
            self.config.max_retries
        ));
        TickOutcome::Action(WatchAction::MarkFailed { wid })
    }
}


// ============================================================================
// WorkerEntry 扩展（extra 的 retries/sess/driven 读写）
// ============================================================================

impl WorkerEntry {
    /// extra 里 retries 缺省视为 0。
    pub fn count_retries(&self) -> u32 {
        self.get_extra("retries").and_then(|v| v.parse().ok()).unwrap_or(0)
    }
}

/// 重建 extra 的 token 列表：删除 set 中出现的键，再按需 append 新值。
fn mutate_extra(entry: &mut WorkerEntry, set: Vec<(&str, Option<String>)>) {
    let mut tokens: Vec<String> = Vec::new();
    for tok in entry.extra.split_whitespace() {
        if let Some((k, _)) = tok.split_once('=') {
            if set.iter().any(|(sk, _)| *sk == k) {
                continue; // 将由 set 覆盖
            }
        }
        tokens.push(tok.to_string());
    }
    for (k, v) in set {
        if let Some(v) = v {
            tokens.push(format!("{k}={}", crate::sanitize_extra(&v)));
        }
    }
    entry.extra = tokens.join(" ");
}

impl WorkerEntry {
    fn set_extra_sess(&mut self, sid: &str) {
        mutate_extra(self, vec![("sess", Some(sid.to_string()))]);
    }
    fn set_extra_retries(&mut self, r: u32) {
        mutate_extra(self, vec![("retries", Some(r.to_string()))]);
    }
    fn set_extra_driven(&mut self, d: bool) {
        mutate_extra(self, vec![("driven", Some(if d { "yes".into() } else { "no".into() }))]);
    }
}



impl WatchdogConfig {
    /// 缺省生产配置：results 目录与 watcher/alerts 日志都在
    /// /server-center/runtime/worker-exec 下，interval 30s / grace 10min / max_retries 2。
    pub fn defaults() -> Self {
        Self {
            interval: Duration::from_secs(30),
            results_dir: PathBuf::from("/server-center/runtime/worker-exec/results"),
            max_retries: 2,
            grace: Duration::from_secs(600),
            watcher_log: PathBuf::from("/server-center/runtime/worker-exec/watchdog.log"),
            alerts_log: PathBuf::from("/server-center/runtime/worker-exec/alerts.log"),
        }
    }
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self::defaults()
    }
}


// ============================================================================
// 看门狗单测（W186）：状态迁移 / 宽限 / 重派 / FAILED / 坏行 / 交付物判定
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkerEntry;
    use celestea_session::SessionSpec;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_secs() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
    }

    /// 建临时 tsv registry + 看门狗配置（结果/日志都在 temp prefix 下）。
    fn fixture(tag: &str) -> (Arc<WorkerRegistry>, WatchdogConfig) {
        let prefix = std::env::temp_dir().join(format!("celestea-watchdog-{tag}-{}", std::process::id()));
        let _ = fs::create_dir_all(&prefix);
        let reg = Arc::new(WorkerRegistry::new(prefix.join("registry.tsv")));
        let _ = fs::create_dir_all(prefix.join("results"));
        (reg, WatchdogConfig::for_test(&prefix))
    }

    /// 造一个「已结束」的会话（TurnStart+TurnEnd，无进行中 turn）并登记为 RUNNING。
    fn ended_started(reg: &WorkerRegistry, wid: &str, extra: &str, started: i64) -> String {
        let sid = reg.sessions().create(SessionSpec { title: format!("{wid}·t"), workspace: None, model: None });
        let s = reg.sessions().get(&sid).unwrap();
        s.log.append(SessionEvent::TurnStart { id: "t1".into() });
        s.log.append(SessionEvent::TurnEnd { id: "t1".into() });
        reg.upsert(WorkerEntry {
            wid: wid.into(),
            started_at: crate::format_utc(started),
            status: WorkerStatus::Running,
            extra: format!("sess={sid} {extra}"),
        })
        .unwrap();
        sid
    }


    #[tokio::test]
    async fn tick_marks_done_when_deliverable_present() {
        let (reg, cfg) = fixture("done");
        let sid = ended_started(&reg, "W1", "brief=write report", now_secs() - 660);
        fs::create_dir_all(&cfg.results_dir).unwrap();
        fs::write(cfg.results_dir.join("W1-看门狗.md"), "report").unwrap();

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0], WatchAction::MarkDone { wid: "W1".into() });

        let e = reg.get_entry("W1").unwrap();
        assert_eq!(e.status, WorkerStatus::Done);
        assert_eq!(e.get_extra("sess").as_deref(), Some(sid.as_str()));
    }

    #[tokio::test]
    async fn tick_keeps_running_for_live_session() {
        let (reg, cfg) = fixture("keep");
        // 有进行中 turn（TurnStart 无 TurnEnd）→ 会话存活
        let sid = reg.sessions().create(SessionSpec { title: "W2·t".into(), workspace: None, model: None });
        let s = reg.sessions().get(&sid).unwrap();
        s.log.append(SessionEvent::TurnStart { id: "t".into() });
        reg.upsert(WorkerEntry {
            wid: "W2".into(),
            started_at: crate::format_utc(now_secs() - 660),
            status: WorkerStatus::Running,
            extra: format!("sess={sid} brief=x"),
        })
        .unwrap();

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions[0], WatchAction::KeepRunning { wid: "W2".into() });
        assert_eq!(reg.get_entry("W2").unwrap().status, WorkerStatus::Running);
    }

    #[tokio::test]
    async fn tick_deferred_during_grace_period() {
        let (reg, cfg) = fixture("grace");
        // started 在宽限期内（现在），会话已结束且无交付物 → 不重派
        ended_started(&reg, "W3", "brief=do work", now_secs());

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions[0], WatchAction::GraceDeferred { wid: "W3".into() });
        assert_eq!(reg.get_entry("W3").unwrap().status, WorkerStatus::Running);
    }

    #[tokio::test]
    async fn tick_fails_when_no_brief_to_respawn() {
        let (reg, cfg) = fixture("nobrief");
        // 超出宽限 + 无 brief → 无法重派 → FAILED
        ended_started(&reg, "W4", "note=no-brief", now_secs() - 660);

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions[0], WatchAction::MarkFailed { wid: "W4".into() });
        assert_eq!(reg.get_entry("W4").unwrap().status, WorkerStatus::Failed);
    }


    #[tokio::test]
    async fn tick_respawns_ended_worker_with_brief() {
        let (reg, cfg) = fixture("respawn");
        // 超出宽限 + 有 brief + retries=0 < 2 → 自动重派（重建会话，retries→1）
        let sid0 = ended_started(&reg, "W5", "brief=write report", now_secs() - 660);
        assert!(sid0.starts_with("session-"));

        let pre_count = reg.sessions().len(); // 1
        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions[0], WatchAction::Respawned { wid: "W5".into(), retries: 1 });

        let e = reg.get_entry("W5").unwrap();
        assert_eq!(e.status, WorkerStatus::Running);
        assert_eq!(e.count_retries(), 1);
        // F2 (W224): 重派释放旧会话并建立新会话，sess 指向新 id；会话总数不再增长。
        assert_eq!(reg.sessions().len(), pre_count, "old session released, new one created (W222 F2)");
        assert!(reg.sessions().get(&sid0).is_none(), "old session must be released on respawn (W222 F2)");
        assert_eq!(reg.mailbox().pending(&sid0), 0, "old mailbox must be purged on respawn (W222 F2)");
        let new_sid = e.get_extra("sess").unwrap();
        assert_ne!(new_sid, sid0);
        assert!(reg.sessions().get(&new_sid).is_some());
    }

    #[tokio::test]
    async fn tick_fails_when_retries_exhausted() {
        let (reg, cfg) = fixture("exhaust");
        // retries=2 == max(2)，超出宽限且无交付物 → FAILED
        ended_started(&reg, "W6", "brief=work retries=2", now_secs() - 660);

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions[0], WatchAction::MarkFailed { wid: "W6".into() });
        assert_eq!(reg.get_entry("W6").unwrap().status, WorkerStatus::Failed);
    }

    #[test]
    fn reads_entries_skip_bad_lines_without_panic() {
        let prefix = std::env::temp_dir().join(format!("celestea-watchdog-badlines-{}", std::process::id()));
        let _ = fs::create_dir_all(&prefix);
        let tsv = prefix.join("bad.tsv");
        fs::write(&tsv, "garbage line without tabs\nW9\t2026-01-01_00:00:00\tBOGUS\tnope\n").unwrap();
        let reg = WorkerRegistry::new(&tsv);
        let entries = reg.read_entries();
        assert!(entries.is_empty(), "bad lines must be skipped: {entries:?}");
        // 看门狗读空表不崩
        let cfg = WatchdogConfig::for_test(&prefix);
        let wd = Watchdog::new(Arc::new(reg), cfg);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let actions = rt.block_on(async { wd.tick().await }).unwrap();
        assert!(actions.is_empty());
    }

    #[tokio::test]
    async fn tick_probe_io_error_skips_round() {
        let (reg, mut cfg) = fixture("probe");
        let _sid0 = ended_started(&reg, "W7", "brief=work", now_secs() - 660);
        // 让交付物目录不存在（或为一个会被 read_dir 报错的路径）→ 探测 IO 错 → ProbeError
        cfg.results_dir = prefix_nonreadable_path();
        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        // 会话已结束、交付物探测 IO 错 → 跳过本轮（不断言流转，只断言不崩且记录）
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0], WatchAction::ProbeError { wid: "W7".into() });
        assert_eq!(reg.get_entry("W7").unwrap().status, WorkerStatus::Running);
    }

    fn prefix_nonreadable_path() -> PathBuf {
        // 用一个指向文件（而非目录）的路径强制 read_dir 失败
        let p = std::env::temp_dir().join(format!("not-a-dir-{}.txt", std::process::id()));
        let _ = fs::write(&p, "x");
        p
    }

    // ---- W224 F3: pending 邮件仅在「有进行中 turn」时才算存活 ----

    #[test]
    fn session_alive_pending_mail_requires_in_progress_turn() {
        let (reg, _cfg) = fixture("alive3");
        // 已结束会话（TurnStart+TurnEnd）+ 1 条未消费邮件 → F3：不视为存活
        // （否则已结束 worker 被永久钉 RUNNING；邮件留存交由 F2 的 release_session 清理）。
        let sid = reg.sessions().create(SessionSpec { title: "W11·t".into(), workspace: None, model: None });
        let s = reg.sessions().get(&sid).unwrap();
        s.log.append(SessionEvent::TurnStart { id: "t1".into() });
        s.log.append(SessionEvent::TurnEnd { id: "t1".into() });
        reg.mailbox().send(&sid, "follow-up", "coordinator");
        assert_eq!(reg.mailbox().pending(&sid), 1);
        assert!(
            !session_alive(&s, reg.mailbox().pending(&sid)),
            "ended session with pending mail must NOT be alive (W222 F3)"
        );

        // 有进行中 turn + 邮件 → 存活。
        let sid2 = reg.sessions().create(SessionSpec { title: "W12·t".into(), workspace: None, model: None });
        let s2 = reg.sessions().get(&sid2).unwrap();
        s2.log.append(SessionEvent::TurnStart { id: "t2".into() });
        reg.mailbox().send(&sid2, "live", "coordinator");
        assert!(
            session_alive(&s2, reg.mailbox().pending(&sid2)),
            "in-progress turn stays alive even with pending mail"
        );
    }

    // ---- W224 F2: DONE / FAILED 释放会话与 mailbox ----

    #[tokio::test]
    async fn tick_done_releases_session_and_mailbox() {
        let (reg, cfg) = fixture("release-done");
        let sid = ended_started(&reg, "W21", "brief=write report", now_secs() - 660);
        // 已结束会话 + 未消费邮件（F3 后不判活）→ DONE 时释放会话与 mailbox（W222 F2）。
        reg.mailbox().send(&sid, "follow-up", "coordinator");
        fs::create_dir_all(&cfg.results_dir).unwrap();
        fs::write(cfg.results_dir.join("W21-看门狗.md"), "report").unwrap();

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0], WatchAction::MarkDone { wid: "W21".into() });

        assert!(reg.sessions().get(&sid).is_none(), "ended session must be released on DONE");
        assert_eq!(reg.mailbox().pending(&sid), 0, "mailbox must be purged on DONE");
        assert_eq!(reg.mailbox().pending_total(), 0);
    }

    #[tokio::test]
    async fn tick_failed_releases_session_and_mailbox() {
        let (reg, cfg) = fixture("release-fail");
        let sid = ended_started(&reg, "W22", "note=no-brief", now_secs() - 660);
        reg.mailbox().send(&sid, "follow-up", "coordinator");

        let wd = Watchdog::new(reg.clone(), cfg);
        let actions = wd.tick().await.unwrap();
        assert_eq!(actions[0], WatchAction::MarkFailed { wid: "W22".into() });
        assert_eq!(reg.get_entry("W22").unwrap().status, WorkerStatus::Failed);

        assert!(reg.sessions().get(&sid).is_none(), "ended session must be released on FAILED");
        assert_eq!(reg.mailbox().pending(&sid), 0, "mailbox must be purged on FAILED");
        assert_eq!(reg.mailbox().pending_total(), 0);
    }
}

