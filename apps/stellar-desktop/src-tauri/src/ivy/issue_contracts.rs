use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceIssueStatus {
    Ready,
    Stale,
    Loading,
    Unavailable,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceIssueState {
    Open,
    Closed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceIssueReference {
    pub repository: String,
    pub number: u32,
    pub title: String,
}

/// Null means not observed; an empty list means observed and empty.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceIssueData {
    pub state: WorkspaceIssueState,
    pub description: Option<String>,
    pub workflow_status: Option<String>,
    pub labels: Option<Vec<String>>,
    pub owner: Option<String>,
    pub blockers: Option<Vec<WorkspaceIssueReference>>,
    pub pull_requests: Option<Vec<WorkspaceIssueReference>>,
}

/// An attributed observation, not a live subscription or action authorization.
/// observed_at_ms is a canonical positive Unix millisecond string, within JS Date range.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceIssuePayload {
    pub title: String,
    pub repository: String,
    pub issue_number: u32,
    pub source: String,
    pub observed_at_ms: Option<String>,
    pub status: WorkspaceIssueStatus,
    pub issue: Option<WorkspaceIssueData>,
}
