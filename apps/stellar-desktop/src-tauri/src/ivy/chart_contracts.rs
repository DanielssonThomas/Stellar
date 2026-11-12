use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceChartType {
    Line,
    Bar,
    Pie,
    Doughnut,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceChartDataset {
    pub label: String,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceChart {
    pub r#type: WorkspaceChartType,
    pub labels: Vec<String>,
    pub datasets: Vec<WorkspaceChartDataset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub x_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub y_label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceChartPayload {
    pub title: String,
    pub chart: WorkspaceChart,
}
