use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceSurface {
    RichText,
    Image,
    Browser,
    Diagram,
    Workflow,
    Session,
    AssistantMessage,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceProminence {
    Primary,
    Secondary,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceToolOperation {
    Open {
        instance_id: String,
        surface: WorkspaceSurface,
        payload_json: String,
        prominence: WorkspaceProminence,
    },
    Update {
        instance_id: String,
        surface: WorkspaceSurface,
        payload_json: String,
    },
    Remove {
        instance_id: String,
    },
    Focus {
        instance_id: String,
    },
    Arrange {
        instance_ids: Vec<String>,
    },
    Clear,
    Inspect,
    CaptureWindow,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceToolRequest {
    pub version: u16,
    pub request_id: String,
    pub epoch: String,
    pub turn_id: String,
    pub operation: WorkspaceToolOperation,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspacePaneMetadata {
    pub instance_id: String,
    pub surface: WorkspaceSurface,
    pub prominence: WorkspaceProminence,
    pub minimized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceToolOutcome {
    Applied,
    Rejected,
    Inspection { panes: Vec<WorkspacePaneMetadata> },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceToolReply {
    pub version: u16,
    pub request_id: String,
    pub epoch: String,
    pub turn_id: String,
    pub outcome: WorkspaceToolOutcome,
}
