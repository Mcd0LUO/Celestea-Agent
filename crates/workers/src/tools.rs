//! celestea-workers：spawn_worker / session_send_message / worker_status 三内置工具（W185）。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};

use async_trait::async_trait;
use celestea_core::{Tool, ToolSpec};
use celestea_session::{ResolveError, SessionSpec};
use serde_json::{json, Value};

use crate::registry::WorkerRegistry;
use crate::types::{utc_now, WorkerEntry, WorkerStatus};

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

/// W235 B：report_to 非空时追加到 worker 简报尾部的中性提示。回执协议已改为
/// 由驱动循环机械执行（W235 A：brief turn 后自动写报告 + mailbox 回执），
/// 不再要求模型调用任何工具——避免与主简报指令冲突、避免 LLM 与驱动
/// 双写不一致。注入结构不变（report_to 非空 → 简报尾部追加一段），只换内容。
fn completion_feedback(_wid: &str, _short: &str, _report_to: &str) -> String {
    "【回执】完成后引擎会自动生成报告并发送回执，你只需专注完成任务本身。".to_string()
}

// --- ToolSpec（按 W180 B1 / B2 给出，worker_status 为 B3 查询工具） ---

fn spawn_worker_spec() -> ToolSpec {
    ToolSpec {
        name: "spawn_worker".into(),
        description: "在 harness 内拉起一个 worker 会话：创建子会话（可入工作区分组）→ 命名（标题=<wid>·<短名>）→ 指定模型 → 投递自包含简报。worker 由 harness 自己的 agent-loop 驱动；看门狗按 registry 判定存活并自动重派失败项。wid 是 worker 编号（如 W101）；brief 是自包含任务简报文本。返回 {ok, sessionId, title, wid}。协作闭环：worker 完成后引擎自动写报告 results/<wid>-<short>.md 并发送 WORKER_<wid>_DONE/FAILED 回执到 report_to 目标会话；回执到达会唤醒目标会话的新一轮处理（主 agent 读报告整合结论）。spawn 后应等待回执到达或经 worker_status 查询进度，再整合各 worker 结论。".into(),
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
                "report_to": { "type": "string", "description": "回报目标会话 id：非空时在简报尾部注入中性回执提示；brief 轮结束后引擎机械写报告 results/<wid>-<short>.md 并发送 WORKER_<wid>_DONE/FAILED 回执到该会话 mailbox；回执到达会唤醒该目标会话新一轮处理（主 agent 读报告整合结论）" }
            },
            "required": ["wid", "brief"],
            "additionalProperties": false
        }),
    }
}

fn session_send_message_spec() -> ToolSpec {
    ToolSpec {
        name: "session_send_message".into(),
        description: "向 harness 内另一个会话发送消息（会话间通讯，用于多 worker 联调、交叉审计、分工协作）。target 可用会话地址（session id）或会话命名（标题/项目/工作区名；按命名指定先解析到唯一地址，命中多个返回候选清单）。content 是发送给目标会话的正文；投递的消息会成为目标会话新一轮的用户输入（唤醒语义：引擎会驱动目标会话就这条消息跑新一轮处理），因此也是 worker 回执与跨会话协作的通道。需要对方回复时在 content 里写明要求，并告诉对方用本工具 target=<你的会话地址> 发回。发送者信息自动附带。".into(),
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
        description: "查询 harness 侧 worker registry（registry.tsv）：返回 RUNNING/DONE/FAILED 汇总（RUNNING 行再按 state 标注细分 in-turn=正在跑 turn / idle=等待 mailbox 消息）；可选按 wid 过滤查看单个 worker 的会话与状态。".into(),
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
    /// W248 解环：对 [WorkerRegistry] 只持 [Weak]（无强引用）——runtime 装配会把
    /// 本工具注册表以 ToolRegistryService 存回 WorkerRegistry（attach_drivers），
    /// 若这里持 Arc 即构成 registry → tools → registry 的强引用环，换代后旧
    /// Runtime 永远无法释放。registry 的生命周期由构造它的 Runtime/插件持有，
    /// 工具只借用：execute 时 upgrade，取不到则 fail-closed（registry released）。
    reg: Weak<WorkerRegistry>,
    exec: fn(Arc<WorkerRegistry>, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>,
}

fn worker_tool(
    spec: ToolSpec,
    reg: Arc<WorkerRegistry>,
    exec: fn(Arc<WorkerRegistry>, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>,
) -> Box<dyn Tool> {
    Box::new(WorkerTool { spec, reg: Arc::downgrade(&reg), exec })
}

#[async_trait]
impl Tool for WorkerTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        // W248 解环：调用时 upgrade。registry 已被释放（宿主 Runtime 换代/
        // shutdown 后）→ fail-closed，不 panic、不复活旧 gen 状态。
        let Some(reg) = self.reg.upgrade() else {
            return Ok(contract_err("registry", "registry released"));
        };
        (self.exec)(reg, args).await
    }
}

/// 三个内置工具：spawn_worker / session_send_message / worker_status。
///
/// W248 解环后工具只持 [Weak]：本函数内部创建的 [WorkerRegistry] 在返回时即
/// 释放，execute 一律返回 contract_err("registry released")。因此本函数仅供
/// spec/形状检查类用途；需要可执行的工具请用 [worker_tools_with] 共享同一个
/// 由调用方持有（Runtime / WorkersPlugin）的 [WorkerRegistry]。
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
    Box::pin(async move { spawn_worker_impl(reg, &args).await })
}

async fn spawn_worker_impl(reg: Arc<WorkerRegistry>, args: &Value) -> Result<Value, String> {
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

    // --- W234 A: report_to 非空 → 把完成反馈指令追加到简报尾部。驱动 brief 与
    // tsv 的 brief token 都用注入后的文本（此前只把 report_to 存进 tsv token，
    // drive_if_possible 传原始 brief → worker 从不写报告/发回执）。
    let brief = match &report_to {
        Some(rt) => format!("{brief}\n\n{}", completion_feedback(&wid, &short, rt)),
        None => brief,
    };

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

    Ok(internal_send(reg, &target, &content))
}

/// 引擎侧内部路径（W185 原语义）：SessionRegistry::resolve → SessionMailbox::send。
fn internal_send(reg: &WorkerRegistry, target: &str, content: &str) -> Value {
    match reg.sessions().resolve(target) {
        Ok(session) => {
            let from = reg.source_label();
            let sent = reg.mailbox().send(session.meta.id.clone(), content.to_string(), from.clone());
            json!({
                "ok": true,
                "delivered": true,
                "queued": true,
                "target": session.meta.id,
                "sourceSession": from,
                "message_id": sent.id,
            })
        }
        Err(ResolveError::NotFound(t)) => {
            contract_err("resolve", format!("no session matches target: {t}"))
        }
        Err(ResolveError::Ambiguous { target: t, candidates }) => {
            let cands: Vec<Value> = candidates
                .iter()
                .map(|m| json!({ "id": m.id, "title": m.title, "workspace": m.workspace, "model": m.model }))
                .collect();
            json!({
                "ok": false,
                "step": "resolve",
                "target": t,
                "candidates": cands,
            })
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

