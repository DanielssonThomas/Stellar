use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[path = "command_names.rs"]
mod command_names;
pub use command_names::{IVY_COMMANDS, IVY_EVENT};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyConnectionState {
    Disconnected,
    Connecting,
    Ready,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyTurnState {
    Idle,
    Submitting,
    Admitted,
    Completed,
    Cancelled,
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyErrorCode {
    MalformedRequest,
    Unavailable,
    Timeout,
    Busy,
    Protocol,
    Uncertain,
    Storage,
    ApprovalRequired,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyRequest {
    pub version: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvySubmitRequest {
    pub version: u16,
    pub input_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvySnapshot {
    pub version: u16,
    pub revision: String,
    pub turn_id: Option<String>,
    pub connection: IvyConnectionState,
    pub turn: IvyTurnState,
    pub items: Vec<super::presentation::IvyPresentation>,
    pub error: Option<IvyErrorCode>,
}

impl Default for IvySnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            revision: "0".into(),
            turn_id: None,
            connection: IvyConnectionState::Disconnected,
            turn: IvyTurnState::Idle,
            items: vec![],
            error: None,
        }
    }
}
