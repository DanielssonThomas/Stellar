use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[path = "command_names.rs"]
mod command_names;
pub use command_names::{IVY_COMMANDS, IVY_EVENT, WORKSPACE_EVENT, WORKSPACE_REPLY_COMMAND};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyConnectionState {
    Disconnected,
    Connecting,
    Ready,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceToolsState {
    Unavailable,
    Available,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyTurnState {
    Idle,
    Submitting,
    Admitted,
    Completed,
    Failed,
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
    TurnFailed,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyModel {
    #[default]
    Terra,
    Sol,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvySelectRequest {
    pub version: u16,
    pub model: IvyModel,
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
    pub model: IvyModel,
    pub verified_model: Option<IvyModel>,
    pub workspace_tools: WorkspaceToolsState,
    pub workspace_epoch: String,
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
            model: IvyModel::Terra,
            verified_model: None,
            workspace_tools: WorkspaceToolsState::Unavailable,
            workspace_epoch: "0".into(),
            connection: IvyConnectionState::Disconnected,
            turn: IvyTurnState::Idle,
            items: vec![],
            error: None,
        }
    }
}
