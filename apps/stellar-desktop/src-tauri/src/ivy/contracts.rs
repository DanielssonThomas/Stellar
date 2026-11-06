pub use super::question_contracts::{IvyQuestion, IvyQuestionAction, IvyQuestionReplyRequest};
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyActivityKind {
    Shell,
    Web,
    FileRead,
    FileWrite,
    Mcp,
    Skill,
    SkillCreate,
    Memory,
    Tool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyActivityState {
    Running,
    Completed,
    Failed,
    Finished,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyActivityProvider {
    Chrome,
    Stellar,
    Github,
    Calendar,
    Spotify,
    Mcp,
    Local,
    Web,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyActivityOperation {
    Search,
    Read,
    Write,
    Open,
    List,
    Inspect,
    Update,
    Execute,
    Call,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyActivity {
    pub id: String,
    pub kind: IvyActivityKind,
    pub state: IvyActivityState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider: Option<IvyActivityProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operation: Option<IvyActivityOperation>,
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
    #[serde(default)]
    pub activity: Vec<IvyActivity>,
    #[serde(default)]
    pub reset_id: Option<String>,
    pub items: Vec<super::presentation::IvyPresentation>,
    pub error: Option<IvyErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_text_observed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub questions: Option<Vec<IvyQuestion>>,
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
            activity: vec![],
            reset_id: None,
            items: vec![],
            error: None,
            first_text_observed: None,
            questions: None,
        }
    }
}
