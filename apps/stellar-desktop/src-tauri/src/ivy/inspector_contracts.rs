use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyInspectorRequest {
    pub version: u16,
    pub session_id: Option<String>,
    #[serde(default)]
    pub offset: u16,
    pub before_message: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvySessionSummary {
    pub id: String,
    pub title: String,
    pub model: Option<String>,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub message_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvySessionRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvySessionMessage {
    pub id: u32,
    pub role: IvySessionRole,
    pub text: String,
    pub at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvySessionContext {
    pub observed_at: Option<String>,
    pub used: Option<u32>,
    pub limit: Option<u32>,
    pub compactions: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyUsageState {
    Loading,
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyUsageWindow {
    pub label: String,
    pub used_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub scope: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyAccountUsage {
    pub state: IvyUsageState,
    pub observed_at: Option<String>,
    pub windows: Vec<IvyUsageWindow>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyInspectorSnapshot {
    pub version: u16,
    pub observed_at: String,
    pub active_session_id: Option<String>,
    pub active_stored_session_id: Option<String>,
    pub selected_session_id: Option<String>,
    pub history_available: bool,
    pub sessions: Vec<IvySessionSummary>,
    pub next_offset: Option<u16>,
    pub messages: Vec<IvySessionMessage>,
    pub next_before: Option<u32>,
    pub context: IvySessionContext,
    pub account: IvyAccountUsage,
}
