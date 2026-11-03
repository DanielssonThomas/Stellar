use super::{workspace_contracts::*, workspace_validate};

fn open(payload: &str) -> WorkspaceToolRequest {
    WorkspaceToolRequest {
        version: 1,
        request_id: "1234567890abcdef1234567890abcdef".into(),
        epoch: "2".into(),
        turn_id: "00000000-0000-4000-8000-000000000001".into(),
        expires_at_ms: "1700000015000".into(),
        operation: WorkspaceToolOperation::Open {
            instance_id: "pane_1".into(),
            surface: WorkspaceSurface::RichText,
            payload_json: payload.into(),
            prominence: WorkspaceProminence::Primary,
        },
    }
}

#[test]
fn validates_bounded_json_and_fences_duplicate_keys_at_all_depths() {
    assert!(workspace_validate::request(&open(
        r#"{"text":"hello","items":[1,2]}"#
    )));
    for payload in [
        r#"{"x":1,"x":2}"#,
        r#"{"x":{"y":1,"y":2}}"#,
        r#"[1,2]"#,
        r#"{"x":1e999}"#,
        r#"{"x":null} trailing"#,
    ] {
        assert!(!workspace_validate::request(&open(payload)));
    }
    assert!(!workspace_validate::request(&open(&format!(
        "{{\"x\":\"{}\"}}",
        "x".repeat(65536)
    ))));
}

#[test]
fn reply_requires_correlated_request_and_metadata_only_outcome() {
    let mut request = open("{}");
    request.operation = WorkspaceToolOperation::Inspect;
    let mut reply = WorkspaceToolReply {
        version: 1,
        request_id: request.request_id.clone(),
        epoch: request.epoch.clone(),
        turn_id: request.turn_id.clone(),
        outcome: WorkspaceToolOutcome::Inspection {
            panes: vec![WorkspacePaneMetadata {
                instance_id: "one".into(),
                surface: WorkspaceSurface::Image,
                prominence: WorkspaceProminence::Primary,
                minimized: false,
                layout: None,
                operations: vec![],
            }],
        },
    };
    assert!(workspace_validate::reply(&request, &reply));
    reply.epoch = "3".into();
    assert!(!workspace_validate::reply(&request, &reply));
    reply.epoch = request.epoch.clone();
    request.operation = WorkspaceToolOperation::CaptureWindow;
    assert!(!workspace_validate::reply(&request, &reply));
    let raw = r#"{"kind":"inspection","panes":[{"instance_id":"one","surface":"image","prominence":"primary","minimized":false,"payload":"secret"}]}"#;
    assert!(serde_json::from_str::<WorkspaceToolOutcome>(raw).is_err());
}
