//! # celestea-core
//!
//! The "everything is a plugin" spine. This crate pins the seams (service
//! definitions): a TypeId-keyed service container, a plugin trait, a typed
//! event bus (broadcast on/emit, intercept bail/run_bail, transform
//! waterfall/run_waterfall), and the Llm / SessionLog / Tool / AgentLoop traits. Concrete
//! providers live in sibling crates and are plugged in at compose time.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::fmt;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ============================================================================
// 1. Plugin container
// ============================================================================

/// Shared, TypeId-keyed service container. Plugins provide services into it;
/// consumers resolve services out of it. A parent chain lets one agent carry a
/// scoped Context layered over the global one (later per-agent presets).
#[derive(Default)]
pub struct Context {
    services: HashMap<TypeId, Arc<dyn Any + Send + Sync>>,
    parent: Option<Arc<Context>>,
}

impl Context {
    pub fn new() -> Self {
        Self { services: HashMap::new(), parent: None }
    }

    /// Register a service. A later registration of the same type replaces an
    /// earlier one (the "patch" semantics in miniature).
    pub fn provide<T: Any + Send + Sync>(&mut self, svc: T) {
        self.services.insert(TypeId::of::<T>(), Arc::new(svc));
    }

    /// Resolve a service by type, falling back to the parent scope.
    pub fn get<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        self.services
            .get(&TypeId::of::<T>())
            .and_then(|a| a.clone().downcast::<T>().ok())
            .or_else(|| self.parent.as_ref().and_then(|p| p.get::<T>()))
    }

    /// Create a child scope that falls back to this context. Each agent gets one.
    pub fn scoped(self: &Arc<Self>) -> Context {
        Context { services: HashMap::new(), parent: Some(self.clone()) }
    }
}

/// A plugin mounts itself by providing services, tools, and event listeners.
/// Everything in the harness — the model adapter, the session log, the tool
/// registry, even the agent loop — is a plugin.
pub trait Plugin: Send + Sync + 'static {
    fn name(&self) -> &'static str {
        std::any::type_name::<Self>()
    }
    fn mount(&self, ctx: &mut Context);
}

/// Named, ordered, replaceable rows: the "patch" primitive. A later row with
/// the same name shadows an earlier one.
#[derive(Default)]
pub struct NamedRegistry<T: Send + Sync> {
    rows: Vec<(String, T)>,
}

impl<T: Send + Sync> NamedRegistry<T> {
    pub fn insert(&mut self, name: impl Into<String>, value: T) {
        self.rows.push((name.into(), value));
    }
    pub fn get(&self, name: &str) -> Option<&T> {
        self.rows.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, T)> {
        self.rows.iter()
    }
}

// ============================================================================
// 2. Typed events: broadcast + intercept (bail) + transform (waterfall)
// ============================================================================

/// A typed event bus with three dispatch modes.
///
/// - on / emit - observe-only broadcast: listeners are Fn(&E) -> ().
/// - bail / run_bail - intercept chain: listeners are Fn(&E) -> Option<R>;
///   they run in registration order and the first Some(r) short-circuits and is
///   returned; if every listener returns None, run_bail returns None. This
///   is the guard / short-circuit primitive for event pipelines.
/// - waterfall / run_waterfall - transform chain: listeners are Fn(&E, R) -> R;
///   they run in registration order, each transforming the value handed to the
///   next layer, starting from an initial value; the final value is returned.
///
/// The three modes live in separate TypeId-keyed maps, so a listener registered
/// in one mode never interferes with another. on/emit remain the observe-only
/// broadcast (backwards compatible).
#[derive(Default)]
pub struct EventBus {
    /// Observe-only broadcast listeners.
    subs: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any) + Send + Sync>>>,
    /// Intercept listeners; the first Some short-circuits (bail mode).
    bailers: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any) -> Option<Box<dyn Any + Send>> + Send + Sync>>>,
    /// Transform listeners; each maps the running value (waterfall mode).
    waterfalls: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any, Box<dyn Any + Send>) -> Box<dyn Any + Send> + Send + Sync>>>,
}

impl EventBus {
    pub fn on<E: Any + Send + Sync>(&mut self, f: impl Fn(&E) + Send + Sync + 'static) {
        let f: Arc<dyn Fn(&dyn Any) + Send + Sync> = Arc::new(move |a| {
            if let Some(e) = a.downcast_ref::<E>() {
                f(e);
            }
        });
        self.subs.entry(TypeId::of::<E>()).or_default().push(f);
    }

    pub fn emit<E: Any + Send + Sync>(&self, event: &E) {
        if let Some(listeners) = self.subs.get(&TypeId::of::<E>()) {
            for f in listeners {
                f(event);
            }
        }
    }

    /// Register an intercept listener (bail mode). Bail listeners for an event
    /// type E should share one result type R; the first Some(r) returned in
    /// registration order short-circuits run_bail.
    pub fn bail<E: Any + Send + Sync, R: Any + Send + 'static>(
        &mut self,
        f: impl Fn(&E) -> Option<R> + Send + Sync + 'static,
    ) {
        let f: Arc<dyn Fn(&dyn Any) -> Option<Box<dyn Any + Send>> + Send + Sync> = Arc::new(move |a| {
            if let Some(e) = a.downcast_ref::<E>() {
                f(e).map(|r| Box::new(r) as Box<dyn Any + Send>)
            } else {
                None
            }
        });
        self.bailers.entry(TypeId::of::<E>()).or_default().push(f);
    }

    /// Run the intercept chain for E, returning the first Some(r) from the
    /// registered bail listeners (registration order), or None if all passed.
    pub fn run_bail<E: Any + Send + Sync, R: Any + Send + 'static>(&self, event: &E) -> Option<R> {
        if let Some(listeners) = self.bailers.get(&TypeId::of::<E>()) {
            for f in listeners {
                if let Some(r) = f(event) {
                    if let Ok(r) = r.downcast::<R>() {
                        return Some(*r);
                    }
                    // Result type mismatch for this request: treat as no-answer
                    // and keep scanning (callers must register one R per event).
                }
            }
        }
        None
    }

    /// Register a transform listener (waterfall mode). Listeners run in
    /// registration order; each maps the running value for the next layer. All
    /// waterfall listeners for an event type E should share one value type R.
    pub fn waterfall<E: Any + Send + Sync, R: Any + Send + 'static>(
        &mut self,
        f: impl Fn(&E, R) -> R + Send + Sync + 'static,
    ) {
        let f: Arc<dyn Fn(&dyn Any, Box<dyn Any + Send>) -> Box<dyn Any + Send> + Send + Sync> =
            Arc::new(move |a, v| {
                if let Some(e) = a.downcast_ref::<E>() {
                    match v.downcast::<R>() {
                        Ok(v) => Box::new(f(e, *v)) as Box<dyn Any + Send>,
                        Err(v) => v, // type mismatch: pass the value through
                    }
                } else {
                    v
                }
            });
        self.waterfalls.entry(TypeId::of::<E>()).or_default().push(f);
    }

    /// Run the transform chain for E, starting from init, returning the value
    /// after every waterfall listener has run (registration order).
    pub fn run_waterfall<E: Any + Send + Sync, R: Any + Send + 'static>(
        &self,
        event: &E,
        init: R,
    ) -> R {
        let mut value: Box<dyn Any + Send> = Box::new(init);
        if let Some(listeners) = self.waterfalls.get(&TypeId::of::<E>()) {
            for f in listeners {
                value = f(event, value);
            }
        }
        *value
            .downcast::<R>()
            .expect("EventBus::run_waterfall: all waterfall listeners for an event type must share one R")
    }
}

// ============================================================================
// 3. LLM seam
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "content", rename_all = "snake_case")]
pub enum Content {
    Text(String),
    ToolCall(ToolCall),
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Content>,
    /// Set for Role::Tool so the result can be matched to its call.
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: Role::User, content: vec![Content::Text(text.into())], tool_call_id: None }
    }
    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: vec![Content::Text(text.into())], tool_call_id: None }
    }
    pub fn assistant_tool_call(call: ToolCall) -> Self {
        Self { role: Role::Assistant, content: vec![Content::ToolCall(call)], tool_call_id: None }
    }
    pub fn tool_result(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self { role: Role::Tool, content: vec![Content::Text(text.into())], tool_call_id: Some(id.into()) }
    }
}

/// The model-facing view of a tool: name, description, and a JSON Schema for args.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Stream events from a provider. Providers emit incremental text deltas for the
/// UI, then a single final Message (text + tool calls) as the last event.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Text(String),
    Done(Message),
}

pub type LlmStream = Pin<Box<dyn Stream<Item = StreamEvent> + Send>>;

#[derive(Debug, Clone)]
pub struct LlmError(pub String);

impl fmt::Display for LlmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for LlmError {}

#[async_trait]
pub trait Llm: Send + Sync {
    async fn generate(&self, req: ModelRequest) -> Result<LlmStream, LlmError>;
}

/// Newtype so Arc<dyn Llm> can live in the Context TypeId map.
pub struct LlmService(pub Arc<dyn Llm>);
impl std::ops::Deref for LlmService {
    type Target = dyn Llm;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

/// A named registry of LLM adapters — the multi-provider seam (W189).
///
/// Mirrors the NamedRegistry "patch" semantics: registration is append-only and
/// a later registration of the same name shadows the earlier one for
/// LlmRegistry::resolve. Compose code registers each provider under a stable
/// name (e.g. "deepseek") and routes requests by name; consumers that still
/// read the single LlmService adapter keep working unchanged.
#[derive(Default)]
pub struct LlmRegistry {
    rows: Vec<(String, Arc<dyn Llm>)>,
}

impl LlmRegistry {
    /// Register (or shadow) a provider adapter under name.
    pub fn register(&mut self, name: impl Into<String>, llm: Arc<dyn Llm>) {
        self.rows.push((name.into(), llm));
    }

    /// Resolve the adapter registered for name (last registration wins), or
    /// None when no adapter was registered under that name.
    pub fn resolve(&self, name: &str) -> Option<Arc<dyn Llm>> {
        self.rows.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }

    /// The distinct provider names currently registered, in first-registration
    /// order (a shadowed name is reported once).
    pub fn list(&self) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for (n, _) in &self.rows {
            if !seen.contains(n) {
                seen.push(n.clone());
            }
        }
        seen
    }
}

/// Newtype so Arc<LlmRegistry> can live in the Context TypeId map, in the same
/// style as LlmService / ToolRegistryService.
pub struct LlmRegistryService(pub Arc<LlmRegistry>);
impl std::ops::Deref for LlmRegistryService {
    type Target = LlmRegistry;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

// ============================================================================
// 4. Session seam (append-only log = single source of truth)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    TurnStart { id: String },
    TurnEnd { id: String },
    UserMessage { text: String },
    AssistantMessage { text: String },
    ToolCall { id: String, name: String, args: Value },
    ToolResult { id: String, value: Option<Value>, error: Option<String> },
}

pub trait SessionLog: Send + Sync {
    fn append(&self, event: SessionEvent);
    fn events(&self) -> Vec<SessionEvent>;
    /// The model-visible projection. The log is the source of truth; history is
    /// derived from it, never stored separately.
    fn derive_messages(&self) -> Vec<Message>;
    fn clear(&self);
}

pub struct SessionService(pub Arc<dyn SessionLog>);
impl std::ops::Deref for SessionService {
    type Target = dyn SessionLog;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

// ============================================================================
// 5. Tool seam
// ============================================================================

#[derive(Debug, Clone)]
pub struct ToolInput {
    pub call_id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub call_id: String,
    /// Canonical, machine-readable result value. Never a display rendering.
    pub value: Option<Value>,
    /// Human-readable rendering of the result, decoupled from the canonical
    /// value (W189). None when the canonical value is already the
    /// human-readable form (e.g. read_file's plain text); Some(_) when a
    /// condensed/derived view reads better than the raw value (e.g. run_shell's
    /// stdout+stderr summary).
    pub render: Option<String>,
    pub error: Option<String>,
    /// The guard verdict for this dispatch. Some(Allow) when the guard chain
    /// passed (execution was permitted); Some(Deny(_)) / Some(Ask(_)) when a
    /// guard short-circuited. Makes Deny/Ask first-class result facts instead
    /// of opaque error strings; the error field is retained for back-compat.
    pub decision: Option<ToolDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolDecision {
    Allow,
    Deny(String),
    Ask(String),
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    async fn execute(&self, args: Value) -> Result<Value, String>;
}

/// A guard is the "waterfall" step: it may Allow, Deny, or Ask. Guards run in
/// registration order; the first non-Allow decision short-circuits dispatch.
#[async_trait]
pub trait ToolGuard: Send + Sync {
    async fn check(&self, input: &ToolInput) -> ToolDecision;
}

#[async_trait]
pub trait ToolRegistry: Send + Sync {
    fn register(&mut self, tool: Box<dyn Tool>);
    fn add_guard(&mut self, guard: Box<dyn ToolGuard>);
    fn get(&self, name: &str) -> Option<&dyn Tool>;
    fn schemas(&self) -> Vec<ToolSpec>;
    /// Run the guard chain, then the tool. Errors are captured, not thrown.
    async fn dispatch(&self, input: ToolInput) -> ToolOutput;
}

pub struct ToolRegistryService(pub Arc<dyn ToolRegistry>);
impl std::ops::Deref for ToolRegistryService {
    type Target = dyn ToolRegistry;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

// ============================================================================
// 6. Agent loop seam
// ============================================================================

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub model: String,
    pub system_prompt: String,
    pub max_steps: usize,
    pub max_parallel_tool_calls: usize,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            model: "deepseek-chat".into(),
            system_prompt: "You are a helpful assistant.".into(),
            max_steps: 16,
            max_parallel_tool_calls: 4,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentError(pub String);

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for AgentError {}

#[async_trait]
pub trait AgentLoop: Send + Sync {
    /// Drive one user turn: append to the session log, loop over model steps,
    /// dispatch tool calls, and write the final assistant message.
    async fn run_turn(&self, ctx: &Context, user_input: &str) -> Result<(), AgentError>;
}

pub struct AgentLoopService(pub Arc<dyn AgentLoop>);
impl std::ops::Deref for AgentLoopService {
    type Target = dyn AgentLoop;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn context_provide_get_roundtrip() {
        let mut ctx = Context::new();
        ctx.provide(42u64);
        assert_eq!(*ctx.get::<u64>().unwrap(), 42u64);
        assert!(ctx.get::<String>().is_none());
    }

    #[test]
    fn context_later_provide_replaces_earlier() {
        let mut ctx = Context::new();
        ctx.provide("first".to_string());
        ctx.provide("second".to_string());
        assert_eq!(ctx.get::<String>().unwrap().as_str(), "second");
    }

    #[test]
    fn context_scoped_falls_back_and_shadows() {
        let mut parent = Context::new();
        parent.provide("parent".to_string());
        parent.provide(7u64);
        let parent = Arc::new(parent);
        let mut child = parent.scoped();
        // falls back to parent
        assert_eq!(child.get::<String>().unwrap().as_str(), "parent");
        // child shadows parent for the same type
        child.provide(9u64);
        assert_eq!(*child.get::<u64>().unwrap(), 9u64);
        // parent is unchanged
        assert_eq!(*parent.get::<u64>().unwrap(), 7u64);
    }

    #[test]
    fn named_registry_last_wins_and_iterates() {
        let mut reg = NamedRegistry::<u32>::default();
        reg.insert("k", 1u32);
        reg.insert("k", 2u32);
        assert_eq!(*reg.get("k").unwrap(), 2u32);
        assert_eq!(reg.iter().count(), 2);
        assert!(reg.get("missing").is_none());
    }

    // ---- W189: ToolOutput render (canonical value vs human render) ----------

    #[test]
    fn tool_output_render_is_separate_from_value() {
        let out = ToolOutput {
            call_id: "c1".into(),
            value: Some(serde_json::json!({ "stdout": "hi", "stderr": "", "exit_code": 0 })),
            render: Some("exit_code: 0\nstdout: hi".into()),
            error: None,
            decision: Some(ToolDecision::Allow),
        };
        // render is decoupled from value: the human view can differ.
        assert_eq!(out.render.as_deref(), Some("exit_code: 0\nstdout: hi"));
        assert!(matches!(out.value, Some(serde_json::Value::Object(_))));
        assert_eq!(out.error, None);
        assert_eq!(out.decision, Some(ToolDecision::Allow));
    }

    #[test]
    fn tool_output_render_defaults_to_none() {
        // A plain-text result (e.g. read_file) needs no separate render: the
        // canonical value IS the human-readable form.
        let out = ToolOutput {
            call_id: "c2".into(),
            value: Some(serde_json::json!("file contents")),
            render: None,
            error: None,
            decision: Some(ToolDecision::Allow),
        };
        assert_eq!(out.value, Some(serde_json::json!("file contents")));
        assert_eq!(out.render, None);
    }

    // ---- W189: LlmRegistry (multi-provider seam) -----------------------------

    /// A provider that always errors; used to exercise the registry without
    /// any network or stream construction.
    struct NoopLlm;
    #[async_trait]
    impl Llm for NoopLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            Err(LlmError("noop".into()))
        }
    }

    #[test]
    fn llm_registry_register_resolve_last_wins() {
        let mut reg = LlmRegistry::default();
        reg.register("deepseek", Arc::new(NoopLlm));
        reg.register("openai", Arc::new(NoopLlm));
        // re-register the same name: last wins (patch semantics)
        reg.register("deepseek", Arc::new(NoopLlm));

        assert!(reg.resolve("deepseek").is_some());
        assert!(reg.resolve("openai").is_some());
        assert!(reg.resolve("anthropic").is_none());
        // the resolved adapter is directly usable as Arc<dyn Llm>
        let _llm: Arc<dyn Llm> = reg.resolve("deepseek").unwrap();
    }

    #[test]
    fn llm_registry_list_reports_distinct_names_in_order() {
        let mut reg = LlmRegistry::default();
        reg.register("deepseek", Arc::new(NoopLlm));
        reg.register("openai", Arc::new(NoopLlm));
        reg.register("deepseek", Arc::new(NoopLlm)); // shadowed, listed once
        assert_eq!(reg.list(), vec!["deepseek".to_string(), "openai".to_string()]);
        // empty registry lists nothing
        assert!(LlmRegistry::default().list().is_empty());
    }

    #[test]
    fn llm_registry_service_derefs_to_registry() {
        let mut reg = LlmRegistry::default();
        reg.register("deepseek", Arc::new(NoopLlm));
        let svc = LlmRegistryService(Arc::new(reg));
        // Deref exposes the registry, so the newtype works in the Context map.
        assert_eq!(svc.list(), vec!["deepseek".to_string()]);
        assert!(svc.resolve("deepseek").is_some());
    }

    #[test]
    fn event_bus_delivers_only_matching_type() {
        #[derive(Debug, PartialEq)]
        struct Ping(u32);
        #[derive(Debug)]
        struct Pong;

        let mut bus = EventBus::default();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        bus.on::<Ping>(move |e| {
            c.fetch_add(e.0 as usize, Ordering::SeqCst);
        });
        bus.emit(&Ping(3));
        bus.emit(&Ping(4));
        bus.emit(&Pong); // wrong type: must not fire the Ping listener
        assert_eq!(count.load(Ordering::SeqCst), 7);
    }

    #[test]
    fn message_constructors_shape_content() {
        let m = Message::user("hi");
        assert!(matches!(m.role, Role::User));
        let tc = Message::assistant_tool_call(ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: serde_json::json!({ "path": "a" }),
        });
        assert!(matches!(tc.content.as_slice(), [Content::ToolCall(_)]));
        let tr = Message::tool_result("c1", "ok");
        assert_eq!(tr.tool_call_id.as_deref(), Some("c1"));
        assert!(matches!(tr.role, Role::Tool));
    }

    #[test]
    fn event_bus_bail_short_circuits_in_order() {
        #[derive(Debug, PartialEq)]
        struct Req {
            path: String,
        }
        let mut bus = EventBus::default();
        let hits = Arc::new(AtomicUsize::new(0));
        let h1 = hits.clone();
        bus.bail::<Req, String>(move |e| {
            h1.fetch_add(1, Ordering::SeqCst);
            if e.path == "blocked" {
                Some("denied".to_string())
            } else {
                None
            }
        });
        let h2 = hits.clone();
        bus.bail::<Req, String>(move |_| {
            h2.fetch_add(1, Ordering::SeqCst);
            Some("fallback".to_string())
        });
        assert_eq!(
            bus.run_bail::<Req, String>(&Req { path: "blocked".into() }),
            Some("denied".into())
        );
        // first Some short-circuits: only the first listener ran
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn event_bus_bail_all_none_returns_none() {
        #[derive(Debug)]
        struct Ping;
        let mut bus = EventBus::default();
        bus.bail::<Ping, u64>(|_| None);
        bus.bail::<Ping, u64>(|_| None);
        assert_eq!(bus.run_bail::<Ping, u64>(&Ping), None);
    }

    #[test]
    fn event_bus_waterfall_transforms_in_order() {
        #[derive(Debug)]
        struct Ctx {
            base: i32,
        }
        let mut bus = EventBus::default();
        bus.waterfall::<Ctx, i32>(|e, v| v + e.base);
        bus.waterfall::<Ctx, i32>(|_, v| v * 2);
        bus.waterfall::<Ctx, i32>(|_, v| v + 1);
        // (0+10)=10 -> *2=20 -> +1=21 ; registration order matters
        assert_eq!(bus.run_waterfall::<Ctx, i32>(&Ctx { base: 10 }, 0), 21);
    }

    #[test]
    fn event_bus_modes_coexist_without_interference() {
        #[derive(Debug, PartialEq, Eq)]
        struct Ping(u32);
        let mut bus = EventBus::default();
        let observed = Arc::new(AtomicUsize::new(0));
        let o = observed.clone();
        bus.on::<Ping>(move |e| {
            o.fetch_add(e.0 as usize, Ordering::SeqCst);
        });
        bus.bail::<Ping, String>(|e| if e.0 == 42 { Some("blocked".into()) } else { None });
        bus.waterfall::<Ping, u64>(|e, v| v + e.0 as u64);
        // broadcast still sees every event
        bus.emit(&Ping(1));
        bus.emit(&Ping(2));
        assert_eq!(observed.load(Ordering::SeqCst), 3);
        // bail chain independent of broadcast
        assert_eq!(bus.run_bail::<Ping, String>(&Ping(42)), Some("blocked".into()));
        assert_eq!(bus.run_bail::<Ping, String>(&Ping(7)), None);
        // waterfall chain independent of broadcast
        assert_eq!(bus.run_waterfall::<Ping, u64>(&Ping(3), 100), 103);
        // broadcast unaffected by the intercept/transform registrations
        bus.emit(&Ping(4));
        assert_eq!(observed.load(Ordering::SeqCst), 7);
    }

    #[test]
    fn event_bus_modes_are_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EventBus>();
    }
}
