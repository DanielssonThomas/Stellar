use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexAvailability {
    pub version: u8,
    pub configured: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexRouting {
    pub version: u8,
    pub local: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexChoice {
    pub id: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReflexMode {
    Professional,
    Playful,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexRequest {
    pub version: u8,
    pub input_id: String,
    pub text: String,
    pub mode: ReflexMode,
    pub context: String,
    pub history: Vec<String>,
    pub actions: Vec<ReflexChoice>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReflexRoute {
    Action,
    Clarify,
    Hermes,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexPlan {
    pub route: ReflexRoute,
    pub action_id: Option<String>,
    pub reply: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexReply {
    pub version: u8,
    pub input_id: String,
    pub plan: Option<ReflexPlan>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReflexMediaAction {
    Play,
    Pause,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    Mute,
    Unmute,
    Inspect,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReflexMediaRequest {
    pub version: u8,
    pub input_id: String,
    pub ticket: String,
    pub action: ReflexMediaAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReflexMediaState {
    pub ticket: String,
    pub player: Option<String>,
    pub title: Option<String>,
    pub playing: bool,
    pub volume: Option<u8>,
    pub muted: Option<bool>,
    pub endpoint_id: Option<String>,
    pub actions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReflexMediaResult {
    Confirmed,
    Rejected,
    Uncertain,
}
