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
fn batches_allow_only_bounded_leaf_mutations_and_aggregate_payloads() {
    let mut request = open("{}");
    let leaf = request.operation.clone();
    request.operation = WorkspaceToolOperation::Batch {
        operations: vec![leaf.clone(), WorkspaceToolOperation::Clear],
    };
    assert!(workspace_validate::request(&request));
    for operations in [
        vec![],
        vec![WorkspaceToolOperation::Clear; 9],
        vec![WorkspaceToolOperation::CaptureWindow],
        vec![WorkspaceToolOperation::Inspect],
        vec![WorkspaceToolOperation::InspectContent {
            instance_id: "pane".into(),
        }],
        vec![WorkspaceToolOperation::Batch {
            operations: vec![leaf.clone()],
        }],
    ] {
        request.operation = WorkspaceToolOperation::Batch { operations };
        assert!(!workspace_validate::request(&request));
    }
    request.operation = WorkspaceToolOperation::Batch {
        operations: vec![WorkspaceToolOperation::Clear; BATCH_MAX_OPERATIONS],
    };
    assert!(workspace_validate::request(&request));
    let max = open(&format!("{{\"text\":\"{}\"}}", "x".repeat(65525))).operation;
    request.operation = WorkspaceToolOperation::Batch {
        operations: vec![max.clone(); 2],
    };
    assert!(workspace_validate::request(&request));
    request.operation = WorkspaceToolOperation::Batch {
        operations: vec![max; 3],
    };
    assert!(!workspace_validate::request(&request));
}

#[test]
fn batch_results_are_correlated_and_match_the_operation_count_without_forged_success() {
    let mut request = open("{}");
    request.operation = WorkspaceToolOperation::Batch {
        operations: vec![request.operation.clone(), WorkspaceToolOperation::Clear],
    };
    let mut reply = WorkspaceToolReply {
        version: 1,
        request_id: request.request_id.clone(),
        epoch: request.epoch.clone(),
        turn_id: request.turn_id.clone(),
        outcome: WorkspaceToolOutcome::Batch {
            outcomes: vec![
                WorkspaceMutationStatus::Applied,
                WorkspaceMutationStatus::Uncertain,
            ],
            panes: Some(vec![]),
        },
    };
    assert!(workspace_validate::reply(&request, &reply));
    let wire = serde_json::to_string(&reply).unwrap();
    assert_eq!(
        serde_json::from_str::<WorkspaceToolReply>(&wire).unwrap(),
        reply
    );
    reply.epoch = "3".into();
    assert!(!workspace_validate::reply(&request, &reply));
    reply.epoch = request.epoch.clone();
    reply.outcome = WorkspaceToolOutcome::Batch {
        outcomes: vec![WorkspaceMutationStatus::Applied],
        panes: None,
    };
    assert!(!workspace_validate::reply(&request, &reply));
    reply.outcome = WorkspaceToolOutcome::Applied;
    assert!(!workspace_validate::reply(&request, &reply));
    reply.outcome = WorkspaceToolOutcome::Rejected;
    assert!(workspace_validate::reply(&request, &reply));
}

#[test]
fn native_screen_requests_are_bounded_and_cannot_be_answered_by_the_renderer() {
    let mut request = open("{}");
    for operation in [
        WorkspaceToolOperation::ListDisplays,
        WorkspaceToolOperation::CaptureForeground,
        WorkspaceToolOperation::CaptureDisplay { display_id: None },
        WorkspaceToolOperation::CaptureDisplay {
            display_id: Some("\\\\.\\DISPLAY1".into()),
        },
    ] {
        request.operation = operation;
        assert!(workspace_validate::request(&request));
        let reply = WorkspaceToolReply {
            version: 1,
            request_id: request.request_id.clone(),
            epoch: request.epoch.clone(),
            turn_id: request.turn_id.clone(),
            outcome: WorkspaceToolOutcome::Displays { displays: vec![] },
        };
        assert!(!workspace_validate::reply(&request, &reply));
        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<WorkspaceToolRequest>(&json).unwrap(),
            request
        );
    }
    for id in ["", "bad\0id", &"x".repeat(129)] {
        request.operation = WorkspaceToolOperation::CaptureDisplay {
            display_id: Some(id.into()),
        };
        assert!(!workspace_validate::request(&request));
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
                render_state: Some(WorkspaceRenderState::Loading),
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
