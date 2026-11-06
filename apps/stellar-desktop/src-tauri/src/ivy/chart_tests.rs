use super::{chart_contracts::WorkspaceChart, chart_validate};
use serde_json::{Value, json};

fn example() -> Value {
    json!({"type":"line","labels":["Mon","Tue"],"datasets":[{"label":"Visits","values":[12.,18.]}]})
}

#[test]
fn accepts_supported_charts_and_signed_cartesian_data() {
    for kind in ["line", "bar", "pie", "doughnut"] {
        let mut value = example();
        value["type"] = kind.into();
        let chart: WorkspaceChart = serde_json::from_value(value.clone()).unwrap();
        assert!(chart_validate::chart(&chart));
        assert!(chart_validate::payload(
            &json!({"title":"Visits","chart":value}).to_string()
        ));
    }
    let mut value = example();
    value["datasets"][0]["values"] = json!([-1.5, 0]);
    assert!(chart_validate::chart(
        &serde_json::from_value(value).unwrap()
    ));
}

#[test]
fn rejects_mismatched_empty_and_excessive_data() {
    for replacement in [json!([]), json!([1]), json!([1, 2, 3]), json!([1e13, 2])] {
        let mut value = example();
        value["datasets"][0]["values"] = replacement;
        assert!(!chart_validate::chart(
            &serde_json::from_value(value).unwrap()
        ));
    }
    let mut value = example();
    value["labels"] = json!([" ", "Tue"]);
    assert!(!chart_validate::chart(
        &serde_json::from_value(value).unwrap()
    ));
}

#[test]
fn circular_charts_require_one_nonnegative_nonzero_dataset() {
    for values in [json!([-1, 2]), json!([0, 0])] {
        let mut value = example();
        value["type"] = "pie".into();
        value["datasets"][0]["values"] = values;
        assert!(!chart_validate::chart(
            &serde_json::from_value(value).unwrap()
        ));
    }
    let mut value = example();
    value["type"] = "doughnut".into();
    value["datasets"] = json!([value["datasets"][0], value["datasets"][0]]);
    assert!(!chart_validate::chart(
        &serde_json::from_value(value).unwrap()
    ));
}

#[test]
fn denies_executable_options_and_unknown_payload_fields() {
    for field in ["options", "plugins", "onClick", "callbacks"] {
        let mut value = example();
        value[field] = json!({});
        assert!(!chart_validate::payload(
            &json!({"title":"Visits","chart":value}).to_string()
        ));
    }
    assert!(!chart_validate::payload(
        "{\"title\":\"Visits\",\"chart\":{},\"html\":\"<script>\"}"
    ));
}

#[test]
fn inline_chart_validation_preserves_other_text_blocks() {
    let value = json!({"title":"Report","blocks":[{"kind":"paragraph","text":"Summary"},{"kind":"chart","chart":example()}]});
    assert!(chart_validate::inline(&value.to_string()));
    let mut invalid = value.clone();
    invalid["blocks"][1]["chart"]["datasets"][0]["values"] = json!([1]);
    assert!(!chart_validate::inline(&invalid.to_string()));
    let mut extra = value;
    extra["blocks"][1]["options"] = json!({});
    assert!(!chart_validate::inline(&extra.to_string()));
}
