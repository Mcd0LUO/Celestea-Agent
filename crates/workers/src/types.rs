//! celestea-workers：Worker 状态机 / registry.tsv 契约行 / UTC 时间戳（W185）。

use std::fmt;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

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

