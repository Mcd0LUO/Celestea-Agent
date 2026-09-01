//! # celestea-core
//!
//! The "everything is a plugin" spine. This crate pins the seams (service
//! definitions): a TypeId-keyed service container, a plugin trait, a typed
//! event bus, and the Llm / SessionLog / Tool / AgentLoop traits. Concrete
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
// 2. Typed broadcast events (observe-only)
// ============================================================================

/// A typed pub/sub bus. Listeners observe; they cannot intercept or short-circuit.
#[derive(Default)]
pub struct EventBus {
    subs: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any) + Send + Sync>>>,
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
    pub value: Option<Value>,
    pub error: Option<String>,
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
