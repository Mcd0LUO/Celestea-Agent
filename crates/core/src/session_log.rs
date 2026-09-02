use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::message::Message;
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
