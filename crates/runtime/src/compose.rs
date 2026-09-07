//! Runtime composition: build the shared celestea_core::Context from a
//! [Profile] — LLM adapter registry, session log (with the
//! CELESTEA_SESSION_DIR persistence switch), tool registry, agent loop and
//! the worker wiring (driven:true semantics, W206). Extracted from the CLI
//! (W214); the terminal renderer wiring was dropped with the CLI.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use celestea_agent_loop::{DefaultAgentLoop, UsageTracker};
use celestea_core::{
    AgentConfig, AgentLoop, AgentLoopService, Context, LlmRegistryService,
    LlmService, SessionLog, SessionService, ToolRegistry,
    ToolRegistryService,
};
use celestea_llm::{deepseek_registry, DeepSeekConfig, DeepSeekLlm};
use celestea_session::{InMemorySessionLog, PersistentSessionLog, Session, SessionMeta};
use celestea_tools::{ProcessRegistry, ProcessRegistryService, ToolRegistryImpl};
use celestea_workers::WorkerRegistry;

use crate::config::{
    resolve_api_key, resolve_base_url, validate_model, Profile,
};
use crate::tools::register_all_tools;

/// 宿主（协调者）会话在引擎内的固定 id：持久化文件名、SessionRegistry 里的
/// 注册 id 与 mailbox 队列键三处共用（W232 会话通讯闭环）。worker 用
/// session_send_message(target="cli-main") 投递回执，Runtime::run_turn 在每轮
/// 开始时 drain 该 mailbox 队列注入宿主日志。
pub(crate) const HOST_SID: &str = "cli-main";

/// The composed runtime engine: every service a turn needs, wired and
/// ready. Built once per process (or per frontend session) via
/// [Runtime::compose]; turns are then driven with [Runtime::run_turn].
pub struct Runtime {
    /// The shared service context: LlmService / LlmRegistryService /
    /// SessionService / ToolRegistryService / AgentLoopService /
    /// WorkerRegistryService are all provided (see compose).
    pub ctx: Context,
    /// The active conversation log (in-memory, or persistent when
    /// CELESTEA_SESSION_DIR is set).
    pub session: Arc<dyn SessionLog>,
    /// The composed tool face: builtin file tools + worker tools.
    pub registry: Arc<dyn ToolRegistry>,
    /// The AgentConfig derived from the profile; run paths rebuild a loop
    /// per turn (with optional cancel + sink) via run::make_loop.
    pub config: AgentConfig,
    /// The shared WorkerRegistry (registry.tsv + session references +
    /// drive seams), also surfaced as WorkerRegistryService in ctx.
    pub workers: Arc<WorkerRegistry>,
    /// Cumulative usage accounting across all turns driven by this Runtime
    /// (W220): the agent loop records every LLM stream's usage here.
    pub usage: Arc<UsageTracker>,
}

impl Runtime {
    /// Compose the engine from a [Profile] — the entry point for every
    /// frontend (web client, server, tests).
    ///
    /// Wires: DeepSeek LLM adapter under the LlmRegistry "deepseek" name
    /// (+ back-compat LlmService), the session log (in-memory by default;
    /// set CELESTEA_SESSION_DIR to switch the host conversation to
    /// PersistentSessionLog — see below), the full tool registry, the
    /// default AgentLoop, and the worker drive seams (driven:true).
    pub fn compose(profile: &Profile) -> Result<Runtime> {
        // Model validation first: reject an empty model up front, before any
        // secret or URL resolution.
        validate_model(&profile.model)?;

        // API key: env[api_key_env] wins, then api_key_file (trimmed), then error.
        // The token value itself never lives in the profile or any log output.
        let api_key = resolve_api_key(profile)?;

        // base_url precedence: profile.base_url -> env DEEPSEEK_BASE_URL -> default.
        let base_url = resolve_base_url(
            profile.base_url.as_deref(),
            std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
        );

        let config = DeepSeekConfig {
            base_url,
            api_key,
            model: profile.model.clone(),
            reasoning_effort: profile.reasoning_effort,
            max_output_tokens: profile.max_output_tokens,
        };
        // LLM adapter registry (multi-provider seam, W189): register the deepseek
        // provider by name, then resolve it. LlmService stays provided for
        // back-compat with consumers that read the single adapter directly;
        // LlmRegistryService is the extension seam for name-routed providers.
        let llm_registry = deepseek_registry(DeepSeekLlm::new(config));
        let resolved = llm_registry
            .resolve("deepseek")
            .expect("deepseek registered above");

        // Session log: default stays in-memory, exactly as before (W210 keeps
        // behavior unless opted in). Set CELESTEA_SESSION_DIR to a directory
        // (e.g. ~/.celestea/sessions) to switch the host conversation to
        // PersistentSessionLog: the engine then replays <dir>/cli-main.jsonl at
        // startup and appends every event to it (crash-safe JSONL, see
        // celestea_session::PersistentSessionLog). A persistence open failure
        // falls back to in-memory so the engine never dies on it.
        let session: Arc<dyn SessionLog> = match std::env::var("CELESTEA_SESSION_DIR") {
            Ok(dir) if !dir.trim().is_empty() => {
                let dir = PathBuf::from(dir.trim());
                match PersistentSessionLog::open(&dir, HOST_SID) {
                    Ok(log) => Arc::new(log),
                    Err(e) => {
                        eprintln!(
                            "[celestea] CELESTEA_SESSION_DIR '{}' unusable ({e}); falling back to in-memory session",
                            dir.display()
                        );
                        Arc::new(InMemorySessionLog::new())
                    }
                }
            }
            _ => Arc::new(InMemorySessionLog::new()),
        };

        let workers = Arc::new(WorkerRegistry::with_default_path());
        // W242 A: session-scoped background process registry — mounted into the
        // Context and shared by run_shell(background) / process_control tools,
        // so detached sandbox processes survive across turns. Runtime drop kills
        // whatever is still running (ProcessRegistry::drop).
        let processes = Arc::new(ProcessRegistry::new());

        // W232 会话通讯闭环：把宿主会话（cli-main）登记进共享 SessionRegistry，
        // 使 worker 侧 session_send_message(target="cli-main") 可按 id 解析并把
        // 回执投进 mailbox["cli-main"]；Runtime::run_turn 每轮开始时 drain 它。
        // 这里只用到 SessionMeta（resolve/send 的寻址面），注册项的日志是空的
        // 影子日志——宿主真实日志是上方的 session。id 固定，不会与 worker 的
        // session-<n> 冲突；register 失败（理论上不会）不阻断 compose。
        let _ = workers.sessions().register(Arc::new(Session::new(SessionMeta {
            id: HOST_SID.to_string(),
            title: HOST_SID.to_string(),
            workspace: None,
            model: Some(profile.model.clone()),
        })));

        let mut registry = ToolRegistryImpl::new();
        register_all_tools(&mut registry, workers.clone(), processes.clone());
        let registry: Arc<dyn ToolRegistry> = Arc::new(registry);

        let usage = Arc::new(UsageTracker::new());
        let config = AgentConfig {
            model: profile.model.clone(),
            system_prompt: profile.system_prompt.clone(),
            max_steps: profile.max_steps,
            max_parallel_tool_calls: profile.max_parallel_tool_calls,
            context_window_tokens: profile.context_window_tokens,
            context_trim_threshold: profile.context_trim_threshold,
            context_keep_recent: profile.context_keep_recent,
        };
        // Back-compat plain loop (no sink, no cancel), wired to the shared
        // usage tracker so worker-driven sessions also report usage; run paths
        // rebuild a per-turn loop with cancel + optional sink via run::make_loop.
        let agent: Arc<dyn AgentLoop> = Arc::new(DefaultAgentLoop::with_bindings(
            config.clone(),
            None,
            None,
            Some(usage.clone()),
        ));

        let mut ctx = Context::new();
        ctx.provide(LlmService(resolved));
        ctx.provide(LlmRegistryService(Arc::new(llm_registry)));
        ctx.provide(SessionService(session.clone()));
        ctx.provide(ToolRegistryService(registry.clone()));
        ctx.provide(AgentLoopService(agent.clone()));
        // WorkersPlugin::mount semantics (see crates/workers/src/plugin.rs): the
        // driver seam (LlmService / ToolRegistryService / AgentLoopService) must be
        // provided *before* attach_drivers so spawn_worker can background-drive
        // spawned sessions (driven:true) instead of only registering them. Then the
        // shared WorkerRegistry is surfaced as a service for consumers to resolve.
        workers.attach_drivers(
            ctx.get::<LlmService>(),
            ctx.get::<ToolRegistryService>(),
            ctx.get::<AgentLoopService>().map(|s| s.0.clone()),
        );
        ctx.provide(celestea_workers::WorkerRegistryService(workers.clone()));
        ctx.provide(ProcessRegistryService(processes));
        Ok(Runtime { ctx, session, registry, config, workers, usage })
    }

    // ========================================================================
    // W248 换代 shutdown（显式、幂等）+ Drop 自动兜底。Studio 换代必须：
    // 旧 gen shutdown → 新 gen compose（调用序与忙期语义见 P0-2 报告）。
    // ========================================================================

    /// W248 显式 shutdown（幂等，可重复调用；Drop 已执行过也安全）。按序：
    /// 1. stop 全部 worker 驱动 —— abort_all_now（notify 全部 stop 信号，让
    ///    阻塞在 mailbox.recv 的驱动循环退出）→ join_drivers 收割到归零；
    /// 2. ProcessRegistry 全杀 —— kill_all（与 Drop 同一路径，进程组 SIGKILL）；
    /// 3. mailbox purge —— purge_all（丢弃所有未消费消息，含旧代回执）；
    /// 4. SessionRegistry 清空 —— clear（cli-main 由下一次 compose 重新登记）。
    /// 全程不 panic（锁毒化走 into_inner；缺服务跳过）。结束后旧 gen 不再
    /// 产生/消费任何消息，也不保留任何强引用（工具持 Weak，环已解）。
    pub async fn shutdown(&self) {
        self.shutdown_now();
        // abort 后的 join 需要 executor，只能在 async 路径做；Drop 只能跑
        // 同步部分（见下）。
        self.workers.join_drivers().await;
    }

    /// shutdown 的同步部分，Drop 自动执行同一路径（不 join：被 abort 的任务
    /// 由 tokio 在取消时释放捕获的 Arc）。幂等：每步对空状态都是 no-op。
    fn shutdown_now(&self) {
        // 1. 停全部 worker 驱动（stop 信号 + abort，不 join）。
        self.workers.abort_all_now();
        // 2. 进程全杀：经 ctx 取回 compose 提供的共享 ProcessRegistry；测试直构
        //    Runtime 缺该服务则跳过（ProcessRegistry 自身 Drop 仍是兜底）。
        if let Some(proc_svc) = self.ctx.get::<ProcessRegistryService>() {
            proc_svc.kill_all();
        }
        // 3. mailbox purge：旧代队列（含旧回执）全部丢弃。
        self.workers.mailbox().purge_all();
        // 4. SessionRegistry 清空：释放全部会话与日志。
        self.workers.sessions().clear();
    }
}

/// W248：Runtime Drop 自动执行 shutdown（不 panic）。驱动 join 无法在 Drop 里
/// await，故只跑同步部分（stop 信号 + abort、进程全杀、mailbox purge、会话
/// 清空）——资源即时释放；被 abort 的任务随取消释放 Arc。环已由 WorkerTool 的
/// Weak 解开：Drop 之后旧 gen 不再被任何强引用钉住（Weak::upgrade 为 None）。
impl Drop for Runtime {
    fn drop(&mut self) {
        self.shutdown_now();
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use celestea_core::{LlmRegistryService, LlmService, ToolRegistry};
    use celestea_tools::ToolRegistryImpl;
    use celestea_workers::WorkerRegistryService;

    fn worker_tool_names(reg: &dyn ToolRegistry) -> Vec<String> {
        reg.schemas().into_iter().map(|s| s.name).collect()
    }

    #[test]
    fn compose_carries_identity_into_loop_config() {
        let key_env = "W194_IDENTITY_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let env = Runtime::compose(&profile).unwrap();
        assert!(env.config.system_prompt.contains("celestea"));
        assert!(env.config.system_prompt.contains("concise"));
        std::env::remove_var(key_env);
    }

    // ---- W189: LLM adapter registry in compose --------------------------------
    #[test]
    fn compose_registers_deepseek_and_keeps_llm_service() {
        // A dedicated env var name so the test never touches a real key.
        let key_env = "W189_TEST_API_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let mut rt = Runtime::compose(&profile).unwrap();

        // The registry seam: deepseek registered and resolvable by name.
        // (Clone the Context so the registry lookup does not borrow rt
        // mutably; Context is the shared service container.)
        let reg = { let ctx = &mut rt.ctx; ctx.get::<LlmRegistryService>() }.unwrap();
        assert_eq!(reg.list(), vec!["deepseek".to_string()]);
        assert!(reg.resolve("deepseek").is_some());
        assert!(reg.resolve("unknown").is_none());

        // Back-compat: the single-adapter LlmService is still provided.
        assert!(rt.ctx.get::<LlmService>().is_some());

        std::env::remove_var(key_env);
    }

    // ---- W206: worker tool surface + driven wiring ---------------------------
    /// compose() must register the three worker-orchestration tools alongside
    /// the six builtin tools (W242 adds process_control + http_request), so
    /// the real agent tool face has all 9.
    #[test]
    fn compose_tool_surface_has_nine_tools() {
        let key_env = "W206_TOOL_SURFACE_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();
        let names = worker_tool_names(&*rt.registry);
        assert_eq!(names.len(), 9, "tool surface = {names:?}");
        for want in ["read_file", "write_file", "list_dir", "run_shell",
                     "process_control", "http_request",
                     "spawn_worker", "session_send_message", "worker_status"] {
            assert!(names.iter().any(|n| n == want), "missing {want} in {names:?}");
        }
        std::env::remove_var(key_env);
    }

    /// The tool-surface registration helper must surface all 9 too.
    #[test]
    fn tools_registration_surfaces_all_nine() {
        let mut registry = ToolRegistryImpl::new();
        register_all_tools(
            &mut registry,
            Arc::new(WorkerRegistry::with_default_path()),
            Arc::new(ProcessRegistry::new()),
        );
        let names = worker_tool_names(&registry);
        assert_eq!(names.len(), 9, "tool list = {names:?}");
        for want in ["read_file", "write_file", "list_dir", "run_shell",
                     "process_control", "http_request",
                     "spawn_worker", "session_send_message", "worker_status"] {
            assert!(names.iter().any(|n| n == want), "missing {want} in {names:?}");
        }
    }

    /// compose() must provide the session-scoped ProcessRegistry as a Context
    /// service (W242 A) so run_shell(background) / process_control share it.
    #[test]
    fn compose_provides_process_registry_service() {
        let key_env = "W242_PROC_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();
        let pr = rt.ctx.get::<ProcessRegistryService>().expect("ProcessRegistryService provided");
        assert_eq!(pr.0.len(), 0);
        std::env::remove_var(key_env);
    }

    // ---- W232: 宿主会话登记（worker 回执可寻址） --------------------------------

    /// compose() must register the host conversation as "cli-main" in the shared
    /// SessionRegistry, so worker-side session_send_message(target="cli-main")
    /// resolves and Runtime::run_turn can drain its mailbox (receipt loop).
    #[test]
    fn compose_registers_host_session_for_receipts() {
        let key_env = "W232_HOST_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();

        let wr = rt.ctx.get::<WorkerRegistryService>().expect("WorkerRegistryService provided");
        let host = wr.0.sessions().resolve("cli-main").expect("host session registered");
        assert_eq!(host.meta.id, "cli-main");
        assert_eq!(host.meta.model.as_deref(), Some(profile.model.as_str()));
        std::env::remove_var(key_env);
    }

    /// compose() must provide the shared WorkerRegistry as a service AND attach the
    /// Llm/ToolRegistry/AgentLoop driver seams (WorkersPlugin::mount semantics), so
    /// a real spawn_worker is background-driven (driven:true) rather than only
    /// registered.
    #[test]
    fn compose_wires_worker_drivers_driven_true() {
        let key_env = "W206_DRIVEN_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();

        let wr = rt.ctx.get::<WorkerRegistryService>().expect("WorkerRegistryService provided");
        // All three driver seams attached => spawn_worker would be driven:true.
        assert!(wr.0.can_drive(), "worker registry must be driver-attached");
        std::env::remove_var(key_env);
    }

    // ---- W248: 强引用环解除 + 换代 shutdown -------------------------------------

    /// 换代验收核心断言：完整 compose 出的 Runtime drop 后，WorkerRegistry 必须
    /// 可释放。worker 三工具只持 Weak——解环前 registry → ToolRegistryService →
    /// WorkerTool → registry 的强环会让本断言失败（upgrade 仍 Some）。用
    /// Weak::strong_count 直接观察：compose 后只有 Runtime.workers 字段与 ctx 里
    /// 的 WorkerRegistryService 两个强引用（工具注册表不增加任何强计数）。
    #[test]
    fn drop_runtime_releases_worker_registry_no_strong_cycle() {
        let key_env = "W248_CYCLE_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();

        let weak = Arc::downgrade(&rt.workers);
        assert_eq!(
            weak.strong_count(),
            2,
            "only Runtime.workers + ctx WorkerRegistryService may hold strong refs (tools must be Weak)"
        );
        drop(rt);
        assert!(
            weak.upgrade().is_none(),
            "WorkerRegistry leaked via a strong cycle after Runtime drop"
        );
        std::env::remove_var(key_env);
    }

    /// W248 shutdown 验收：幂等 + 驱动全部退出 + 进程全杀 + mailbox 清空 +
    /// SessionRegistry 清空。驱动 seam 换成 no-op AgentLoop（不触网）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_stops_drivers_kills_processes_and_purges() {
        struct NoopLoop;
        #[async_trait::async_trait]
        impl celestea_core::AgentLoop for NoopLoop {
            async fn run_turn(
                &self,
                _ctx: &celestea_core::Context,
                _input: &str,
            ) -> Result<(), celestea_core::AgentError> {
                Ok(())
            }
        }

        let key_env = "W248_SHUTDOWN_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();

        // 驱动 seam 换成 no-op loop：compose 注入的是真实 DeepSeek seam，测试不触网。
        rt.workers.attach_drivers(
            rt.ctx.get::<LlmService>(),
            rt.ctx.get::<celestea_core::ToolRegistryService>(),
            Some(Arc::new(NoopLoop)),
        );

        // 一个活 driver：brief turn 后阻塞在 mailbox.recv，直到 shutdown 通知停止。
        let sid = rt.workers.sessions().create(celestea_session::SessionSpec {
            title: "w248-drv".into(),
            ..Default::default()
        });
        assert!(rt.workers.drive_if_possible(&sid, "task").await, "driver must start");
        rt.workers.mailbox().send(&sid, "queued for driver", "coordinator");
        // 旧代回执（host 队列，无消费者，直到 shutdown 才被 purge）。
        rt.workers.mailbox().send(crate::compose::HOST_SID, "stale receipt", "W9");
        assert!(rt.workers.background_len() >= 1, "driver task tracked");
        assert_eq!(rt.workers.mailbox().pending(crate::compose::HOST_SID), 1, "stale receipt queued");

        // 一个后台 sleep 进程：shutdown 后应被 kill_all 杀死并从 registry 移除。
        let proc_svc =
            rt.ctx.get::<ProcessRegistryService>().expect("ProcessRegistryService provided");
        let mut child = tokio::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn sleep");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("child stdout");
        let stderr = child.stderr.take().expect("child stderr");
        proc_svc.0.insert(child, stdin, stdout, stderr);
        assert_eq!(proc_svc.len(), 1, "sleep process registered");

        // 显式 shutdown；再跑一次验证幂等（第二步全为 no-op，不 panic）。
        rt.shutdown().await;
        rt.shutdown().await;

        assert_eq!(rt.workers.background_len(), 0, "all drivers stopped and joined");
        assert_eq!(rt.workers.mailbox().pending_total(), 0, "mailbox fully purged");
        assert_eq!(rt.workers.sessions().len(), 0, "SessionRegistry cleared");
        assert_eq!(proc_svc.len(), 0, "background processes killed");
        std::env::remove_var(key_env);
    }

    // ---- W210: CELESTEA_SESSION_DIR persistence switch -------------------------
    #[tokio::test]
    async fn compose_honors_session_dir_persistence() {
        let dir = std::env::temp_dir().join(format!(
            "celestea-rt-sess-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("CELESTEA_SESSION_DIR", &dir);
        let key_env = "W214_SESS_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();

        // The host conversation is backed by PersistentSessionLog: an appended
        // event lands in <dir>/cli-main.jsonl (flush per append is the default).
        rt.session.append(celestea_core::SessionEvent::UserMessage {
            text: "persisted".into(),
        });
        let jsonl = dir.join("cli-main.jsonl");
        let content = std::fs::read_to_string(&jsonl).unwrap_or_default();
        assert!(content.contains("persisted"), "jsonl content: {content}");

        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var(key_env);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

