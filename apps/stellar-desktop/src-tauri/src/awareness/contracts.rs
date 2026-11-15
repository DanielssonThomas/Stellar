use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[path = "command_names.rs"]
mod command_names;
pub use command_names::{AWARENESS_COMMANDS, AWARENESS_EVENT};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum AwarenessHealth {
    Available,
    Unavailable,
    Paused,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessApp {
    pub app: String,
    pub title: String,
    pub observed_at_ms: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessMedia {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub observed_at_ms: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessPane {
    pub title: String,
    pub surface: String,
    pub selected: bool,
    pub minimized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessWorkspace {
    pub version: u16,
    pub epoch: String,
    pub panes: Vec<AwarenessPane>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessRequest {
    pub version: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessSetEnabled {
    pub version: u16,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct AwarenessSnapshot {
    pub version: u16,
    pub revision: String,
    pub enabled: bool,
    pub app_health: AwarenessHealth,
    pub media_health: AwarenessHealth,
    pub media_observed_at_ms: Option<String>,
    pub foreground: Option<AwarenessApp>,
    pub last_external: Option<AwarenessApp>,
    pub spotify: Option<AwarenessMedia>,
    pub workspace: Option<AwarenessWorkspace>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum AwarenessError {
    MalformedRequest,
    Unavailable,
    Storage,
}
