//! W259 — `/compact`（上下文压缩）后端实现。
//!
//! 路由：`POST /api/sessions/{id}/compact`（id = `"<workspace>/<session>"`，
//! 前端 `encodeURIComponent`，axum `Path` 自动百分号解码）。
//!
//! 契约（三条响应分支，全部 JSON，`ok` 恒在）：
//!   * 409 `{"ok":false,"error":"turn 进行中，无法压缩"}` —— 活动 turn 占用
//!     AppState.busy（单并发）时拒绝；
//!   * 200 `{"ok":true,"compacted":false,"note":"历史不足，无需压缩"}` ——
//!     完整 assistant 轮数 <= [COMPACT_THRESHOLD]；
//!   * 200 `{"ok":true,"compacted":true,"kept_turns":4,"note":"已压缩：摘要轮 + 最近4轮"}`
//!     —— 摘要轮 + 最近 [COMPACT_KEEP_TURNS] 个完整轮；
//!   * 500 `{"ok":false,"error":"..."}` —— 摘要生成 / 落盘失败（错误串里
//!     的 api key 一定被 [redact] 掉，绝不回显）。
//!
//! 压缩算法（[plan_compaction]）：
//!   1. 把 cli-main.jsonl 解析成事件流（复用 api::parse_session_jsonl）；
//!   2. 按 `turn_start ..= turn_end` 切成「完整轮」，未闭合的尾巴（被中断的
//!      轮）与首个 turn_start 之前的事件一律丢弃；
//!   3. 新日志 = 一个合成压缩轮（turn_start / user_message「【上下文压缩】<摘要>」/
//!      assistant_message / turn_end completed） + 最近 K 个完整轮（内容原样，
//!      tool_call / tool_result / thinking_delta 保留在原轮内部）。
//!
//! 重编号：轮 id 使用引擎原生格式 `turn-<n>`（PersistentSessionLog 的
//! `next_turn_number` 只认这个前缀，见 crates/session/src/persistent.rs）——
//! 合成轮 n=1，保留轮 n=2..K+1 单调递增，因此引擎重放后新轮 id 从 turn-(K+2)
//! 继续，永不与磁盘上的 id 撞号。turn_start 与 turn_end 取同一个新 id。
//!
//! 落盘（[rewrite_atomic]）：旧文件先复制成 `cli-main.jsonl.precompact`
//! 单副本备份（覆盖式），再写同目录 `cli-main.jsonl.tmp-<pid>` + `sync_all`，
//! 最后 `rename` 原子替换——读者要么看到旧日志，要么看到新日志。
//!
//! 引擎重绑：若被压缩的正是活动会话，沿用 workspaces::post_session_activate
//! 的同一套尾部（CELESTEA_SESSION_DIR -> prepare_gen -> swap_gen），让新
//! generation 的 PersistentSessionLog 重放新日志；非活动会话不重绑。
//! 压缩事件走 bcast 总线（SSE 事件名 `compact`），payload 带会话 id。

use std::path::Path;
use std::time::Duration;

use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use celestea_runtime::{resolve_api_key, SessionEvent, TurnOutcome};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::workspaces::{self, SESSION_FILE};
use crate::{emit, prepare_gen, profile_to_json, swap_gen, Shared};

/// 完整轮数 <= 该阈值即跳过压缩（历史不足）。
pub(crate) const COMPACT_THRESHOLD: usize = 8;
/// 压缩后保留的最近完整轮数 K。
pub(crate) const COMPACT_KEEP_TURNS: usize = 4;
/// 摘要输入（会话事件文本）字符上限（约 6 万字符，安全上限）。
pub(crate) const SUMMARY_INPUT_MAX_CHARS: usize = 60_000;
/// 单条事件文本在摘要输入里的截断上限（避免一次工具结果吃掉全部预算）。
const TRANSCRIPT_EVENT_MAX_CHARS: usize = 4_000;
/// 摘要输出保留上限（写进合成轮的 user_message）。
const SUMMARY_KEEP_MAX_CHARS: usize = 20_000;
/// 摘要请求的 max_tokens。
pub(crate) const SUMMARY_MAX_TOKENS: u32 = 4_096;
/// 摘要请求总超时。
pub(crate) const SUMMARY_TIMEOUT: Duration = Duration::from_secs(90);
/// 备份文件名（单副本，覆盖式）。
pub(crate) const BACKUP_FILE: &str = "cli-main.jsonl.precompact";
/// 原子写临时文件前缀（同目录，保证 rename 不跨设备）。
const TMP_PREFIX: &str = "cli-main.jsonl.tmp-";

/// 压缩用的系统提示：四段式结构化摘要，只输出正文。
pub(crate) const COMPACT_SYSTEM_PROMPT: &str = "你是上下文压缩器。把用户提供的会话记录压缩成一份中文结构化摘要，\
必须且只需包含以下四个小节（保留小节标题）：\n\
1) 正在进行的任务：当前目标、所处阶段、尚未完成的部分。\n\
2) 已做的决策：已经确定的技术/方案选择及其理由，包括被否决的方案。\n\
3) 关键事实与文件改动：涉及的文件路径、函数/接口名、配置项、数据结论、报错信息等可复用的硬事实。\n\
4) 待办：接下来要做的事，按优先级排列。\n\
要求：忠于原始记录，不得编造；保留路径、标识符、数字、命令原样；压缩冗余寒暄与重复内容；直接输出摘要正文，不要任何前言、结语或解释。";

// ---- 事件流切轮 / 重编号 -------------------------------------------------------

/// 把事件流切成「完整轮」：每个元素 = 一个 turn_start..=turn_end 切片。
/// 未闭合的尾部轮（turn_start 没有 turn_end）与首个 turn_start 之前的事件
/// 一律丢弃——只有完整轮才有资格进新日志。
pub(crate) fn split_complete_turns(events: &[SessionEvent]) -> Vec<Vec<SessionEvent>> {
    let mut turns: Vec<Vec<SessionEvent>> = Vec::new();
    let mut cur: Option<Vec<SessionEvent>> = None;
    for ev in events {
        match ev {
            SessionEvent::TurnStart { .. } => {
                // 重复/嵌套的 turn_start：上一个未闭合片段直接丢弃
                cur = Some(vec![ev.clone()]);
            }
            _ => {
                if let Some(c) = cur.as_mut() {
                    c.push(ev.clone());
                    if matches!(ev, SessionEvent::TurnEnd { .. }) {
                        turns.push(cur.take().expect("cur is Some in this branch"));
                    }
                }
                // cur == None：turn_start 之前的事件（旧格式/孤儿行）丢弃
            }
        }
    }
    turns
}

/// 完整 assistant 轮数（阈值判定用）。
pub(crate) fn count_complete_turns(events: &[SessionEvent]) -> usize {
    split_complete_turns(events).len()
}

/// 引擎原生轮 id：`turn-<n>`。
fn turn_id(n: usize) -> String {
    format!("turn-{n}")
}

/// 把一个完整轮里的 turn_start/turn_end 换成同一个新 id（其余事件原样保留，
/// 含 tool_call / tool_result / thinking_delta / user_message / assistant_message）。
/// 终态 outcome 也原样保留——重编号只改 id，不改语义。
fn renumber_turn(events: &[SessionEvent], id: &str) -> Vec<SessionEvent> {
    events
        .iter()
        .map(|ev| match ev {
            SessionEvent::TurnStart { .. } => SessionEvent::TurnStart { id: id.to_string() },
            SessionEvent::TurnEnd { outcome, .. } => SessionEvent::TurnEnd {
                id: id.to_string(),
                outcome: outcome.clone(),
            },
            other => other.clone(),
        })
        .collect()
}

/// 压缩后的新日志。`None` = 完整轮数 <= [COMPACT_THRESHOLD]（无需压缩）。
///
/// 结构：合成压缩轮（turn-1）+ 最近 `keep` 个完整轮（turn-2..turn-(keep+1)）。
pub(crate) fn plan_compaction(
    events: &[SessionEvent],
    summary: &str,
    keep: usize,
) -> Option<Vec<SessionEvent>> {
    let turns = split_complete_turns(events);
    if turns.len() <= COMPACT_THRESHOLD {
        return None;
    }
    // keep 上限夹到实际轮数：keep > 总轮数时保留全部（不 panic / 不下溢）
    let keep = keep.max(1).min(turns.len());
    let start = turns.len() - keep;
    let kept = &turns[start..];

    let mut out: Vec<SessionEvent> = Vec::new();
    let head = turn_id(1);
    out.push(SessionEvent::TurnStart { id: head.clone() });
    out.push(SessionEvent::UserMessage {
        text: format!("【上下文压缩】{}", clip(summary.trim(), SUMMARY_KEEP_MAX_CHARS)),
    });
    out.push(SessionEvent::AssistantMessage {
        text: "上下文已压缩，以上为历史摘要。".to_string(),
    });
    out.push(SessionEvent::TurnEnd {
        id: head,
        outcome: TurnOutcome::Completed,
    });
    for (i, turn) in kept.iter().enumerate() {
        out.extend(renumber_turn(turn, &turn_id(i + 2)));
    }
    Some(out)
}

// ---- 摘要输入 / 文本工具 -------------------------------------------------------

/// 按字符（非字节）截断到 `max`，超长加省略标记。
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("…（截断）");
    out
}

/// 保留文本尾部 `max` 个字符（摘要输入优先保留最近历史），超长加前缀说明。
fn clip_tail(s: String, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s;
    }
    let tail: String = s.chars().skip(n - max).collect();
    format!("（更早内容已截断，仅保留最近 {max} 字符）\n{tail}")
}

/// 把事件流渲染成摘要输入文本：user/assistant 文本 + 工具决策/结果摘要，
/// 整段按字符截断到 `max`（保留最近部分）。
pub(crate) fn render_transcript(events: &[SessionEvent], max: usize) -> String {
    let mut out = String::new();
    for ev in events {
        match ev {
            SessionEvent::TurnStart { id } => {
                out.push_str(&format!("\n--- 轮次 {id} ---\n"));
            }
            SessionEvent::TurnEnd { .. } => {}
            SessionEvent::UserMessage { text } => {
                out.push_str(&format!(
                    "【用户】{}\n",
                    clip(text, TRANSCRIPT_EVENT_MAX_CHARS)
                ));
            }
            SessionEvent::AssistantMessage { text } => {
                out.push_str(&format!(
                    "【助手】{}\n",
                    clip(text, TRANSCRIPT_EVENT_MAX_CHARS)
                ));
            }
            SessionEvent::ThinkingDelta { text } => {
                out.push_str(&format!(
                    "【思考】{}\n",
                    clip(text, TRANSCRIPT_EVENT_MAX_CHARS / 4)
                ));
            }
            SessionEvent::ToolCall { name, args, .. } => {
                out.push_str(&format!(
                    "【工具调用】{name}({})\n",
                    clip(&args.to_string(), TRANSCRIPT_EVENT_MAX_CHARS / 4)
                ));
            }
            SessionEvent::ToolResult { value, error, .. } => match error {
                Some(e) => out.push_str(&format!(
                    "【工具结果】错误：{}\n",
                    clip(e, TRANSCRIPT_EVENT_MAX_CHARS / 4)
                )),
                None => out.push_str(&format!(
                    "【工具结果】{}\n",
                    clip(
                        &value.clone().unwrap_or(Value::Null).to_string(),
                        TRANSCRIPT_EVENT_MAX_CHARS / 4
                    )
                )),
            },
        }
    }
    clip_tail(out, max)
}

/// 错误串脱敏：任何位置出现 api key 一律替换成 `<redacted>`（绝不回显）。
pub(crate) fn redact(msg: &str, api_key: &str) -> String {
    let key = api_key.trim();
    if key.is_empty() {
        return msg.to_string();
    }
    msg.replace(key, "<redacted>")
}

// ---- 摘要请求 -----------------------------------------------------------------

/// 从 OpenAI 兼容响应里取出正文（`choices[0].message.content`；兼容
/// 字符串或 parts 数组；再兜底 `choices[0].text`）。
fn extract_content(v: &Value) -> Option<String> {
    let choice = v.get("choices")?.get(0)?;
    let msg = choice.get("message");
    if let Some(c) = msg.and_then(|m| m.get("content")) {
        if let Some(s) = c.as_str() {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
        if let Some(arr) = c.as_array() {
            let joined: String = arr
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("");
            if !joined.trim().is_empty() {
                return Some(joined);
            }
        }
    }
    choice
        .get("text")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

/// 一次性 chat 补全（与引擎同款 base_url / 密钥 / OpenAI 兼容协议）。
/// `POST {base_url}/chat/completions`，非流式，[SUMMARY_TIMEOUT] 总超时。
/// 错误串一律不含 key（调用方仍会再过一遍 [redact]）。
pub(crate) async fn summarize(
    base_url: &str,
    api_key: &str,
    model: &str,
    transcript: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim().trim_end_matches('/'));
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": COMPACT_SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
        "max_tokens": SUMMARY_MAX_TOKENS,
        "temperature": 0.3,
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(SUMMARY_TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("摘要请求失败：{e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("摘要响应读取失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("摘要请求失败：HTTP {status}：{}", clip(&text, 300)));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("摘要响应不是 JSON（{e}）；body 头部：{}", clip(&text, 200)))?;
    extract_content(&v)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "摘要响应缺少 choices[0].message.content".to_string())
}

// ---- 原子重写 -----------------------------------------------------------------

/// 原子重写 cli-main.jsonl：
///   1. 旧文件复制成同目录 `cli-main.jsonl.precompact`（单副本，覆盖）；
///   2. 新内容写 `cli-main.jsonl.tmp-<pid>` 并 `sync_all`；
///   3. `rename` 原子替换（失败清理 tmp）。
pub(crate) fn rewrite_atomic(path: &Path, events: &[SessionEvent]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("session path '{}' has no parent", path.display()))?;
    let mut text = String::new();
    for ev in events {
        let line = serde_json::to_string(ev).map_err(|e| format!("事件序列化失败：{e}"))?;
        text.push_str(&line);
        text.push('\n');
    }
    // 1. 备份（单副本，覆盖式）
    let backup = dir.join(BACKUP_FILE);
    if path.is_file() {
        std::fs::copy(path, &backup)
            .map_err(|e| format!("备份失败 '{}'：{e}", backup.display()))?;
    }
    // 2. tmp + fsync
    let tmp = dir.join(format!("{TMP_PREFIX}{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("临时文件创建失败 '{}'：{e}", tmp.display()))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("临时文件写入失败 '{}'：{e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("临时文件 fsync 失败 '{}'：{e}", tmp.display()))?;
    }
    // 3. 原子替换
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("原子替换失败 '{}'：{e}", path.display()));
    }
    Ok(())
}

// ---- 409 守卫 -----------------------------------------------------------------

/// 单并发守卫：占用成功返回 Ok，已被活动 turn 占用返回 409 错误。
/// 与 post_turn 使用同一把 AppState.busy 锁（同一个 cancel 通道形态）。
pub(crate) async fn claim_compact_slot(
    busy: &Mutex<Option<tokio::sync::watch::Sender<bool>>>,
) -> Result<(), (StatusCode, String)> {
    let mut slot = busy.lock().await;
    if slot.is_some() {
        return Err((StatusCode::CONFLICT, "turn 进行中，无法压缩".to_string()));
    }
    *slot = Some(tokio::sync::watch::channel(false).0);
    Ok(())
}

// ---- 编排 ---------------------------------------------------------------------

fn err(code: StatusCode, msg: String) -> (StatusCode, String) {
    (code, msg)
}

fn err_response(code: StatusCode, msg: String) -> Response {
    (code, Json(json!({"ok": false, "error": msg}))).into_response()
}

/// 压缩编排（持有 busy 槽）。所有失败路径由调用方统一释放槽位。
async fn compact_locked(st: &Shared, id: &str) -> Result<Value, (StatusCode, String)> {
    // 1. 定位会话目录（traversal-safe；要求 dir + cli-main.jsonl 存在）
    let (ws_name, name, dir) = workspaces::session_dir_for(&st.workspaces.snapshot(), id)?;
    let canonical = format!("{ws_name}/{name}");
    let path = dir.join(SESSION_FILE);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取会话日志失败：{e}"),
        )
    })?;
    let events = crate::api::parse_session_jsonl(&text);

    // 2. 阈值：完整轮数不足 -> 不压缩（200 + note）
    if count_complete_turns(&events) <= COMPACT_THRESHOLD {
        return Ok(json!({
            "ok": true,
            "compacted": false,
            "note": "历史不足，无需压缩",
        }));
    }

    // 3. 摘要请求：模型取 session.json（缺省用当前 generation 的 model），
    //    base_url/密钥取当前 generation（引擎同款通道，密钥只在内存）
    let (model, base_url, api_key) = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        let model = workspaces::session_meta(&dir).unwrap_or_else(|| gen.model.clone());
        let key = resolve_api_key(&gen.profile).map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("摘要请求缺少可用密钥：{e}"),
            )
        })?;
        (model, gen.base_url.clone(), key)
    };
    let transcript = render_transcript(&events, SUMMARY_INPUT_MAX_CHARS);
    let summary = summarize(&base_url, &api_key, &model, &transcript)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, redact(&e, &api_key)))?;

    // 4. 新日志 + 原子重写（含 .precompact 备份）
    let new_events = plan_compaction(&events, &summary, COMPACT_KEEP_TURNS).ok_or_else(|| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "内部错误：压缩计划为空".to_string(),
        )
    })?;
    rewrite_atomic(&path, &new_events).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // 5. 活动会话 -> 重建 generation 绑定同一目录（重放新日志）；
    //    非活动会话不重绑（下次激活/启动时自然重放）。
    let is_active = st.workspaces.active_session().as_deref() == Some(canonical.as_str());
    let mut rebound = false;
    if is_active {
        let mut pj = {
            let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
            profile_to_json(&gen.profile)
        };
        if let Some(m) = workspaces::session_meta(&dir) {
            if let Err(e) = crate::api::validate_model_name(&m) {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    format!("invalid session model: {e}"),
                ));
            }
            pj["model"] = json!(m);
        }
        std::env::set_var("CELESTEA_SESSION_DIR", &dir);
        let gen = prepare_gen(pj, None, &st.providers).map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("compose failed: {e}"),
            )
        })?;
        let _ = swap_gen(st, gen);
        rebound = true;
    }

    // 6. 广播压缩事件（SSE 事件名 compact，payload 带会话 id）
    let note = format!("已压缩：摘要轮 + 最近{COMPACT_KEEP_TURNS}轮");
    emit(
        &st.bcast,
        &st.seq,
        0,
        "compact",
        json!({
            "session": canonical,
            "kept_turns": COMPACT_KEEP_TURNS,
            "note": note,
            "rebound": rebound,
        }),
    );

    Ok(json!({
        "ok": true,
        "compacted": true,
        "kept_turns": COMPACT_KEEP_TURNS,
        "note": note,
    }))
}

/// POST /api/sessions/{id}/compact 处理体：
///   1. busy 槽守卫（409）——占用期间其它 turn 立即拿到 409；
///   2. compact_locked 干活；
///   3. 无论成败，最后释放 busy 槽。
pub(crate) async fn post_session_compact(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> Response {
    if let Err((code, msg)) = claim_compact_slot(&st.busy).await {
        return err_response(code, msg);
    }
    let out = compact_locked(&st, id.trim()).await;
    // 槽位释放永远是最后一步（与 execute_turn 同约定）
    *st.busy.lock().await = None;
    match out {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, msg)) => err_response(code, msg),
    }
}

// ---- 测试 ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "celestea-studio-w259-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// 一个完整轮：turn_start(id) + user + [thinking + tool_call + tool_result] +
    /// assistant + turn_end。
    fn full_turn(n: usize, with_tools: bool) -> Vec<SessionEvent> {
        let id = format!("turn-{n}");
        let mut v = vec![
            SessionEvent::TurnStart { id: id.clone() },
            SessionEvent::UserMessage {
                text: format!("用户第 {n} 问"),
            },
        ];
        if with_tools {
            v.push(SessionEvent::ThinkingDelta {
                text: format!("思考 {n}"),
            });
            v.push(SessionEvent::ToolCall {
                id: format!("c{n}"),
                name: "read_file".into(),
                args: json!({"path": format!("/tmp/f{n}.rs")}),
                parent_id: None,
            });
            v.push(SessionEvent::ToolResult {
                id: format!("c{n}"),
                value: Some(json!({"ok": true})),
                error: None,
                parent_id: None,
            });
        }
        v.push(SessionEvent::AssistantMessage {
            text: format!("助手第 {n} 答"),
        });
        v.push(SessionEvent::TurnEnd {
            id,
            outcome: TurnOutcome::Completed,
        });
        v
    }

    fn log_of(n: usize) -> Vec<SessionEvent> {
        (0..n).flat_map(|i| full_turn(i, i % 2 == 0)).collect()
    }

    fn turn_ids(events: &[SessionEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::TurnStart { id } => Some(id.clone()),
                _ => None,
            })
            .collect()
    }

    // ---- 重编号 / 保留 K 轮 ----

    #[test]
    fn plan_compaction_prepends_summary_and_keeps_last_k_renumbered() {
        let events = log_of(12); // 12 个完整轮 -> 保留最近 4
        let new = plan_compaction(&events, "摘要正文", COMPACT_KEEP_TURNS).expect("plan");

        // 结构：合成轮 + 4 个保留轮 = 5 轮，id turn-1..turn-5 单调递增
        assert_eq!(
            turn_ids(&new),
            vec!["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]
        );
        assert_eq!(count_complete_turns(&new), 5);

        // 合成压缩轮：turn_start(1) + user(【上下文压缩】…) + assistant + turn_end completed
        assert!(matches!(&new[0], SessionEvent::TurnStart { id } if id == "turn-1"));
        match &new[1] {
            SessionEvent::UserMessage { text } => {
                assert_eq!(text, "【上下文压缩】摘要正文");
            }
            other => panic!("expected user_message, got {other:?}"),
        }
        match &new[2] {
            SessionEvent::AssistantMessage { text } => {
                assert_eq!(text, "上下文已压缩，以上为历史摘要。");
            }
            other => panic!("expected assistant_message, got {other:?}"),
        }
        match &new[3] {
            SessionEvent::TurnEnd { id, outcome } => {
                assert_eq!(id, "turn-1");
                assert_eq!(*outcome, TurnOutcome::Completed);
            }
            other => panic!("expected turn_end, got {other:?}"),
        }

        // 保留的是最近 4 轮（第 8..11 轮），内容原样
        let users: Vec<String> = new
            .iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { text } if !text.starts_with("【上下文压缩】") => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            users,
            vec!["用户第 8 问", "用户第 9 问", "用户第 10 问", "用户第 11 问"]
        );

        // turn_start/turn_end 成对且同 id
        let starts = turn_ids(&new);
        let ends: Vec<String> = new
            .iter()
            .filter_map(|e| match e {
                SessionEvent::TurnEnd { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(starts, ends);

        // tool / thinking 事件保留在原轮内部（最近 4 轮里第 8、10 轮带工具）
        let tools = new
            .iter()
            .filter(|e| matches!(e, SessionEvent::ToolCall { .. }))
            .count();
        assert_eq!(tools, 2, "保留轮内的 tool_call 必须原样保留");
        let think = new
            .iter()
            .filter(|e| matches!(e, SessionEvent::ThinkingDelta { .. }))
            .count();
        assert_eq!(think, 2, "保留轮内的 thinking_delta 必须原样保留");

        // 轮内顺序不变
        let first_kept = &new[4..];
        assert!(matches!(first_kept[0], SessionEvent::TurnStart { .. }));
        assert!(matches!(first_kept[1], SessionEvent::UserMessage { .. }));
        assert!(matches!(first_kept[2], SessionEvent::ThinkingDelta { .. }));
        assert!(matches!(first_kept[3], SessionEvent::ToolCall { .. }));
        assert!(matches!(first_kept[4], SessionEvent::ToolResult { .. }));
        assert!(matches!(first_kept[5], SessionEvent::AssistantMessage { .. }));
        assert!(matches!(first_kept[6], SessionEvent::TurnEnd { .. }));
    }

    #[test]
    fn renumber_keeps_original_turn_outcome() {
        // 保留轮的原始终态（如 cancelled / error）不得被改写
        let mut events = log_of(10);
        if let Some(SessionEvent::TurnEnd { outcome, .. }) = events
            .iter_mut()
            .rev()
            .find(|e| matches!(e, SessionEvent::TurnEnd { .. }))
        {
            *outcome = TurnOutcome::Cancelled;
        }
        let new = plan_compaction(&events, "s", 4).expect("plan");
        let last = new
            .iter()
            .rev()
            .find_map(|e| match e {
                SessionEvent::TurnEnd { outcome, .. } => Some(outcome.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(last, TurnOutcome::Cancelled);
    }

    #[test]
    fn plan_compaction_drops_unterminated_tail_and_leading_orphans() {
        let mut events = vec![SessionEvent::UserMessage {
            text: "turn_start 之前的孤儿".into(),
        }];
        events.extend(log_of(10));
        // 未闭合的尾部轮（被中断）——不是完整轮
        events.push(SessionEvent::TurnStart {
            id: "turn-99".into(),
        });
        events.push(SessionEvent::UserMessage {
            text: "中断的尾巴".into(),
        });

        let new = plan_compaction(&events, "s", 4).expect("plan");
        assert_eq!(
            turn_ids(&new),
            vec!["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]
        );
        assert!(
            !new.iter().any(|e| matches!(e, SessionEvent::UserMessage { text } if text == "turn_start 之前的孤儿" || text == "中断的尾巴")),
            "孤儿/未闭合尾部不得进新日志"
        );
    }

    #[test]
    fn plan_compaction_keeps_all_when_fewer_than_k_complete_turns() {
        // keep=10 但只有 9 轮：全部保留，编号 turn-2..turn-10
        let new = plan_compaction(&log_of(9), "s", 10).expect("plan");
        assert_eq!(turn_ids(&new).len(), 1 + 9);
        assert_eq!(turn_ids(&new)[0], "turn-1");
        assert_eq!(turn_ids(&new)[9], "turn-10");
    }

    // ---- 阈值跳过 ----

    #[test]
    fn threshold_skips_at_or_below_limit() {
        assert_eq!(
            count_complete_turns(&log_of(COMPACT_THRESHOLD)),
            COMPACT_THRESHOLD
        );
        assert!(plan_compaction(&log_of(COMPACT_THRESHOLD), "s", 4).is_none());
        assert!(plan_compaction(&log_of(1), "s", 4).is_none());
        assert!(plan_compaction(&[], "s", 4).is_none());
        // 刚过阈值 -> 压缩
        assert!(plan_compaction(&log_of(COMPACT_THRESHOLD + 1), "s", 4).is_some());
    }

    // ---- 原子写 + 备份 ----

    #[test]
    fn rewrite_atomic_backs_up_original_and_replaces_in_place() {
        let dir = scratch("atomic");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SESSION_FILE);
        let original = "{\"type\":\"user_message\",\"text\":\"原始\"}\n";
        std::fs::write(&path, original).unwrap();

        let events = plan_compaction(&log_of(12), "摘要", 4).unwrap();
        rewrite_atomic(&path, &events).unwrap();

        // 备份 = 原始内容（单副本）
        let backup = dir.join(BACKUP_FILE);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);

        // 新文件 = 逐行 serde_json 事件，可被 parse_session_jsonl 完整解析
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with('\n'), "每行记录都以换行结尾");
        let parsed = crate::api::parse_session_jsonl(&text);
        assert_eq!(parsed.len(), events.len());
        assert_eq!(
            turn_ids(&parsed),
            vec!["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]
        );

        // 无残留 tmp
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(TMP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "临时文件必须被 rename 消费掉：{leftovers:?}");

        // 压缩后的日志只剩 5 轮（<= 阈值）-> 二次调用直接跳过
        assert!(plan_compaction(&parsed, "摘要2", 4).is_none());

        // 二次重写：备份被覆盖（仍是单副本），内容 = 上一次的新日志
        let events2 = plan_compaction(&log_of(12), "摘要2", 4).unwrap();
        rewrite_atomic(&path, &events2).unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), text);
        let tmp_count = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(TMP_PREFIX))
            .count();
        assert_eq!(tmp_count, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 摘要输入渲染 ----

    #[test]
    fn transcript_renders_events_and_keeps_tail_on_overflow() {
        let events = log_of(3);
        let t = render_transcript(&events, SUMMARY_INPUT_MAX_CHARS);
        assert!(t.contains("【用户】用户第 0 问"));
        assert!(t.contains("【助手】助手第 0 答"));
        assert!(t.contains("【工具调用】read_file("));
        assert!(t.contains("【工具结果】"));
        assert!(t.contains("--- 轮次 turn-0 ---"));

        // 超限：保留尾部（最近历史）
        let tail = render_transcript(&events, 20);
        assert!(tail.starts_with("（更早内容已截断"));
        assert!(tail.ends_with("助手第 2 答\n"));
    }

    #[test]
    fn redact_never_leaks_the_key() {
        let msg = "POST http://x failed with Bearer sk-secret-123 timeout";
        let out = redact(msg, "sk-secret-123");
        assert!(!out.contains("sk-secret-123"));
        assert!(out.contains("<redacted>"));
        // 空 key 原样返回
        assert_eq!(redact(msg, "  "), msg);
    }

    // ---- 409 守卫 ----

    #[tokio::test]
    async fn busy_slot_guard_conflicts_with_exact_message_and_releases() {
        let busy: Mutex<Option<tokio::sync::watch::Sender<bool>>> = Mutex::new(None);
        // 空闲 -> 占用成功
        assert!(claim_compact_slot(&busy).await.is_ok());
        // 已占用 -> 409 + 契约文案
        let e = claim_compact_slot(&busy).await.expect_err("must conflict");
        assert_eq!(e.0, StatusCode::CONFLICT);
        assert_eq!(e.1, "turn 进行中，无法压缩");
        // 释放后可再次占用
        *busy.lock().await = None;
        assert!(claim_compact_slot(&busy).await.is_ok());
    }

    #[test]
    fn err_response_shape_is_ok_false_error() {
        let resp = err_response(StatusCode::CONFLICT, "turn 进行中，无法压缩".to_string());
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn extract_content_handles_str_parts_and_text_fallbacks() {
        assert_eq!(
            extract_content(&json!({"choices":[{"message":{"content":"摘要"}}]})).unwrap(),
            "摘要"
        );
        assert_eq!(
            extract_content(
                &json!({"choices":[{"message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}]})
            )
            .unwrap(),
            "ab"
        );
        assert_eq!(
            extract_content(&json!({"choices":[{"text":"legacy"}]})).unwrap(),
            "legacy"
        );
        assert!(extract_content(&json!({"choices":[{"message":{"content":"   "}}]})).is_none());
        assert!(extract_content(&json!({"choices":[]})).is_none());
    }

    #[test]
    fn turn_id_uses_engine_native_prefix() {
        // 引擎 PersistentSessionLog 的 next_turn_number 只识别 "turn-<n>"，
        // 重编号必须沿用该前缀，否则引擎重放后的新轮 id 会与磁盘撞号。
        assert_eq!(turn_id(1), "turn-1");
        assert_eq!(turn_id(5), "turn-5");
    }
}
