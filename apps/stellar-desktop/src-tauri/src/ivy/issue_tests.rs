use super::{
    issue_contracts::WorkspaceIssuePayload, issue_validate, workspace_contracts::*,
    workspace_validate,
};
use serde_json::{Value, json};

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/workspace-issue.json"
    ))
    .unwrap()
}

fn request(operation: WorkspaceToolOperation) -> WorkspaceToolRequest {
    WorkspaceToolRequest {
        version: 1,
        request_id: "1234567890abcdef1234567890abcdef".into(),
        epoch: "2".into(),
        turn_id: "00000000-0000-4000-8000-000000000001".into(),
        expires_at_ms: "1794554249258".into(),
        operation,
    }
}

fn open(value: &Value) -> WorkspaceToolOperation {
    WorkspaceToolOperation::Open {
        instance_id: "issue".into(),
        surface: WorkspaceSurface::GithubIssue,
        prominence: WorkspaceProminence::Primary,
        payload_json: value.to_string(),
    }
}

fn scores(value: &Value) -> Vec<Value> {
    let show = json!({"kind":"show","panel":{"detail":{"surface":"github-issue","payload":value}}});
    vec![
        json!({"prepare":[show]}),
        json!({"segments":[{"actions":[show]}]}),
        json!({"segments":[{"after":[show]}]}),
    ]
}

#[test]
fn shared_issue_fixtures_validate_on_direct_and_all_spatial_routes() {
    let fixtures = fixtures();
    let valid = &fixtures["valid"];
    assert!(workspace_validate::request(&request(open(valid))));
    let typed: WorkspaceIssuePayload = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), *valid);
    for case in fixtures["invalid"].as_array().unwrap() {
        let mut value = valid.clone();
        let path = case["path"].as_array().unwrap();
        let mut parent = &mut value;
        for key in &path[..path.len() - 1] {
            parent = &mut parent[key.as_str().unwrap()];
        }
        parent[path.last().unwrap().as_str().unwrap()] = case["value"].clone();
        assert!(
            !workspace_validate::request(&request(open(&value))),
            "{case}"
        );
        for score in scores(&value) {
            assert!(
                !workspace_validate::request(&request(WorkspaceToolOperation::Present {
                    score_json: score.to_string()
                })),
                "{case}"
            );
        }
    }
    for score in scores(valid) {
        assert!(issue_validate::spatial(&score.to_string()));
    }
}

#[test]
fn nullable_fields_are_required_and_states_do_not_fabricate_data() {
    let mut value = fixtures()["valid"].clone();
    for field in [
        "description",
        "workflow_status",
        "labels",
        "owner",
        "blockers",
        "pull_requests",
    ] {
        value["issue"][field] = Value::Null;
    }
    assert!(issue_validate::payload(&value.to_string()));
    for field in [
        "description",
        "workflow_status",
        "labels",
        "owner",
        "blockers",
        "pull_requests",
    ] {
        let mut missing = value.clone();
        missing["issue"].as_object_mut().unwrap().remove(field);
        assert!(!issue_validate::payload(&missing.to_string()));
    }
    for state in ["loading", "unavailable", "error"] {
        value["status"] = state.into();
        value["issue"] = Value::Null;
        value["observed_at_ms"] = Value::Null;
        assert!(issue_validate::payload(&value.to_string()));
    }
}

#[test]
fn payload_size_unicode_and_correlation_are_enforced() {
    let mut value = fixtures()["valid"].clone();
    value["title"] = "é".repeat(121).into();
    assert!(!workspace_validate::request(&request(open(&value))));
    value = fixtures()["valid"].clone();
    let mut req = request(open(&value));
    let reply = WorkspaceToolReply {
        version: 1,
        request_id: req.request_id.clone(),
        epoch: req.epoch.clone(),
        turn_id: req.turn_id.clone(),
        outcome: WorkspaceToolOutcome::Applied,
    };
    assert!(workspace_validate::reply(&req, &reply));
    req.epoch = "3".into();
    assert!(!workspace_validate::reply(&req, &reply));
    let raw = value.to_string();
    let duplicate = raw.replacen("{", "{\"title\":\"duplicate\",", 1);
    req = request(WorkspaceToolOperation::Update {
        instance_id: "issue".into(),
        surface: WorkspaceSurface::GithubIssue,
        payload_json: duplicate,
        expected_revision: Some(0),
    });
    assert!(!workspace_validate::request(&req));
    assert!(!issue_validate::payload(&" ".repeat(16385)));
}

#[test]
fn shared_raw_semantics_and_hidden_parent_parity() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/workspace-issue-duplicates.json"
    ))
    .unwrap();
    let cases = std::iter::once((fixtures["valid_payload_json"].as_str().unwrap(), true)).chain(
        fixtures["semantic_invalid"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| (case["payload_json"].as_str().unwrap(), false)),
    );
    for (raw, expected) in cases {
        assert_eq!(issue_validate::payload(raw), expected);
        for wrapper in fixtures["spatial_wrappers"].as_array().unwrap() {
            let score = format!(
                "{}{}{}",
                wrapper["prefix"].as_str().unwrap(),
                raw,
                wrapper["suffix"].as_str().unwrap()
            );
            for score in [
                &score,
                &score.replacen("\"surface\"", "\"surfac\\u0065\"", 1),
            ] {
                assert_eq!(
                    issue_validate::spatial(score),
                    expected,
                    "{}",
                    wrapper["name"]
                );
                assert_eq!(
                    workspace_validate::request(&request(WorkspaceToolOperation::Present {
                        score_json: score.into()
                    })),
                    expected,
                    "{}",
                    wrapper["name"]
                );
                for key in ["hidden_suffix", "hidden_escaped_suffix"] {
                    let hidden = format!(
                        "{}{}",
                        &score[..score.len() - 1],
                        wrapper[key].as_str().unwrap()
                    );
                    assert!(!issue_validate::spatial(&hidden));
                    assert!(!workspace_validate::request(&request(
                        WorkspaceToolOperation::Present { score_json: hidden }
                    )));
                }
            }
        }
    }
}

#[test]
fn shared_raw_duplicate_keys_fail_before_spatial_value_parsing() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/workspace-issue-duplicates.json"
    ))
    .unwrap();
    let valid = fixtures["valid_payload_json"].as_str().unwrap();
    let cases = std::iter::once(("valid", valid, true)).chain(
        fixtures["invalid"].as_array().unwrap().iter().map(|case| {
            (
                case["name"].as_str().unwrap(),
                case["payload_json"].as_str().unwrap(),
                false,
            )
        }),
    );
    for (name, raw, expected) in cases {
        assert_eq!(issue_validate::payload(raw), expected, "{name}");
        let operation = WorkspaceToolOperation::Open {
            instance_id: "issue".into(),
            surface: WorkspaceSurface::GithubIssue,
            payload_json: raw.into(),
            prominence: WorkspaceProminence::Primary,
        };
        assert_eq!(
            workspace_validate::request(&request(operation)),
            expected,
            "{name}"
        );
        let inspect = request(WorkspaceToolOperation::InspectContent {
            instance_id: "issue".into(),
        });
        let reply = WorkspaceToolReply {
            version: 1,
            request_id: inspect.request_id.clone(),
            epoch: inspect.epoch.clone(),
            turn_id: inspect.turn_id.clone(),
            outcome: WorkspaceToolOutcome::Content {
                instance_id: "issue".into(),
                surface: WorkspaceSurface::GithubIssue,
                revision: 0,
                payload_json: raw.into(),
            },
        };
        assert_eq!(
            workspace_validate::reply(&inspect, &reply),
            expected,
            "{name}"
        );
        for wrapper in fixtures["spatial_wrappers"].as_array().unwrap() {
            let score = format!(
                "{}{}{}",
                wrapper["prefix"].as_str().unwrap(),
                raw,
                wrapper["suffix"].as_str().unwrap()
            );
            assert_eq!(
                issue_validate::spatial(&score),
                expected,
                "{name}: {}",
                wrapper["name"]
            );
            assert_eq!(
                workspace_validate::request(&request(WorkspaceToolOperation::Present {
                    score_json: score
                })),
                expected,
                "{name}: {}",
                wrapper["name"]
            );
        }
    }
}
