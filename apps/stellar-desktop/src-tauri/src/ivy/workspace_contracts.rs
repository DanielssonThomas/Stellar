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
    ActivitySummary,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceProminence {
    Primary,
    Secondary,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSplitPlacement {
    Left,
    Right,
    Above,
    Below,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSplitAxis {
    Horizontal,
    Vertical,
}

/// Horizontal divides top/bottom; vertical divides left/right. Percent belongs to first.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceLayoutNode {
    Pane {
        instance_id: String,
    },
    Split {
        split_id: String,
        axis: WorkspaceSplitAxis,
        percent: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        equal_panes: Option<bool>,
        first: Box<WorkspaceLayoutNode>,
        second: Box<WorkspaceLayoutNode>,
    },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_revision: Option<u32>,
    },
    Remove {
        instance_id: String,
    },
    Focus {
        instance_id: String,
    },
    Minimize {
        instance_id: String,
    },
    Restore {
        instance_id: String,
    },
    Maximize {
        instance_id: String,
    },
    Resize {
        instance_id: String,
        percent: u8,
    },
    Swap {
        instance_id: String,
        other_id: String,
    },
    SetLayout {
        tree: WorkspaceLayoutNode,
    },
    SplitPane {
        instance_id: String,
        other_id: String,
        split_id: String,
        placement: WorkspaceSplitPlacement,
    },
    ResizeSplit {
        split_id: String,
        percent: u8,
    },
    RestoreLayout,
    InspectContent {
        instance_id: String,
    },
    Arrange {
        instance_ids: Vec<String>,
    },
    Clear,
    Inspect,
    CaptureWindow,
    ListDisplays,
    CaptureDisplay {
        display_id: Option<String>,
    },
    CaptureForeground,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceDisplay {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    pub foreground: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceToolRequest {
    pub version: u16,
    pub request_id: String,
    pub epoch: String,
    pub turn_id: String,
    pub expires_at_ms: String,
    pub operation: WorkspaceToolOperation,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspacePaneMetadata {
    pub instance_id: String,
    pub surface: WorkspaceSurface,
    pub prominence: WorkspaceProminence,
    pub minimized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_state: Option<WorkspaceRenderState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<WorkspacePaneLayout>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<WorkspacePaneOperation>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRenderState {
    Ready,
    Loading,
    Error,
    Hidden,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePaneOperation {
    Focus,
    Minimize,
    Restore,
    Close,
    Arrange,
    Swap,
    Resize,
    Maximize,
    RestoreLayout,
    Update,
    InspectContent,
    Gallery,
    BrowserNavigation,
    FocusAgent,
}

/// Coordinates are normalized to thousandths of the viewport, including hidden panes (zero area).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspacePaneLayout {
    pub title: String,
    pub revision: u32,
    pub selected: bool,
    pub maximized: bool,
    pub position: u8,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceToolOutcome {
    Displays {
        displays: Vec<WorkspaceDisplay>,
    },
    Applied,
    Rejected,
    Inspection {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tree: Option<WorkspaceLayoutNode>,
        panes: Vec<WorkspacePaneMetadata>,
    },
    Content {
        instance_id: String,
        surface: WorkspaceSurface,
        revision: u32,
        payload_json: String,
    },
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
