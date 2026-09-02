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
use celestea_session::{InMemorySessionLog, PersistentSessionLog};
use celestea_tools::ToolRegistryImpl;
use celestea_workers::WorkerRegistry;

use crate::config::{
    resolve_api_key, resolve_base_url, validate_model, Profile,
};
use crate::tools::register_all_tools;

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
                match PersistentSessionLog::open(&dir, "cli-main") {
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

        let mut registry = ToolRegistryImpl::new();
        register_all_tools(&mut registry, workers.clone());
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
        Ok(Runtime { ctx, session, registry, config, workers, usage })
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
    /// compose() must register the three worker-orchestration tools alongside the
    /// four builtin file tools, so the real agent tool face has all 7.
    #[test]
    fn compose_tool_surface_has_seven_tools() {
        let key_env = "W206_TOOL_SURFACE_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let rt = Runtime::compose(&profile).unwrap();
        let names = worker_tool_names(&*rt.registry);
        assert_eq!(names.len(), 7, "tool surface = {names:?}");
        for want in ["read_file", "write_file", "list_dir", "run_shell",
                     "spawn_worker", "session_send_message", "worker_status"] {
            assert!(names.iter().any(|n| n == want), "missing {want} in {names:?}");
        }
        std::env::remove_var(key_env);
    }

    /// The tool-surface registration helper must surface all 7 too.
    #[test]
    fn tools_registration_surfaces_all_seven() {
        let mut registry = ToolRegistryImpl::new();
        register_all_tools(&mut registry, Arc::new(WorkerRegistry::with_default_path()));
        let names = worker_tool_names(&registry);
        assert_eq!(names.len(), 7, "tool list = {names:?}");
        for want in ["read_file", "write_file", "list_dir", "run_shell",
                     "spawn_worker", "session_send_message", "worker_status"] {
            assert!(names.iter().any(|n| n == want), "missing {want} in {names:?}");
        }
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

