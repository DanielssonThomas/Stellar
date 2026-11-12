use super::chart_contracts::{WorkspaceChart, WorkspaceChartPayload, WorkspaceChartType};
use serde_json::Value;

fn text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

pub(super) fn chart(value: &WorkspaceChart) -> bool {
    let circular = matches!(
        value.r#type,
        WorkspaceChartType::Pie | WorkspaceChartType::Doughnut
    );
    !value.labels.is_empty()
        && value.labels.len() <= 64
        && value.labels.iter().all(|label| text(label, 120))
        && !value.datasets.is_empty()
        && value.datasets.len() <= if circular { 1 } else { 8 }
        && [&value.x_label, &value.y_label]
            .iter()
            .all(|label| label.as_ref().is_none_or(|value| text(value, 120)))
        && value.datasets.iter().all(|dataset| {
            text(&dataset.label, 120)
                && dataset.values.len() == value.labels.len()
                && dataset.values.iter().all(|number| {
                    number.is_finite() && number.abs() <= 1e12 && (!circular || *number >= 0.)
                })
                && (!circular || dataset.values.iter().any(|number| *number > 0.))
        })
}

pub(super) fn payload(value: &str) -> bool {
    serde_json::from_str::<WorkspaceChartPayload>(value)
        .is_ok_and(|payload| text(&payload.title, 240) && chart(&payload.chart))
        && serde_json::from_str::<Value>(value)
            .ok()
            .and_then(|value| value.get("chart").cloned())
            .is_some_and(|value| optional_labels(&value))
}

fn optional_labels(value: &Value) -> bool {
    ["x_label", "y_label"]
        .iter()
        .all(|key| value.get(key).is_none_or(Value::is_string))
}

pub(super) fn inline(value: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    value
        .get("blocks")
        .and_then(Value::as_array)
        .is_none_or(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("kind").and_then(Value::as_str) == Some("chart"))
                .all(|block| {
                    block.as_object().is_some_and(|block| block.len() == 2)
                        && block.get("chart").is_some_and(|value| {
                            optional_labels(value)
                                && serde_json::from_value::<WorkspaceChart>(value.clone())
                                    .is_ok_and(|value| chart(&value))
                        })
                })
        })
}
