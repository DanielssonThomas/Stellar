#![cfg(windows)]
use super::{
    contracts::*, journal::Record, journal::WorkspaceDescriptor, lifecycle::Control,
    process::Broker, session::Session, session_tests::fixture,
};
use serde_json::{Value, json};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

fn wire(mode: Option<&str>) -> (Session, std::path::PathBuf, std::path::PathBuf) {
    let (mut session, directory) = fixture();
    session.record.session_id = Some("current".into());
    session.record.input_id = None;
    session.record.admission_id = None;
    session.record.unsettled = false;
    session.record.workspace = Some(WorkspaceDescriptor {
        port: 1,
        credential_ref: "a".repeat(32),
    });
    session.shared.update(1, |view| {
        view.connection = IvyConnectionState::Ready;
        view.turn = IvyTurnState::Idle;
    });
    let audit = directory.join("inert-peer-audit.json");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tools/native/ivy_retained_wire_fixture.py");
    let mut command =
        Command::new(std::env::var("STELLAR_TEST_PYTHON").unwrap_or_else(|_| "python".into()));
    command
        .args(["-B", "-u"])
        .arg(script)
        .arg(&audit)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    if let Some(mode) = mode {
        command.arg(mode);
    }
    session.broker = Some(Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap());
    (session, directory, audit)
}

#[test]
fn serialized_load_crosses_actual_python_worker_and_rust_journal_without_losing_fields() {
    let (mut session, directory, audit) = wire(None);
    let contract: Value = serde_json::from_str(include_str!(
        "../../../src/app/testing/retained-recovery-wire.json"
    ))
    .unwrap();
    // Actual renderer DTO serialization, not a direct helper return fixture.
    let request: IvyLoadRetainedRequest =
        serde_json::from_value(contract["renderer_request"].clone()).unwrap();
    let result = session.control(Control::LoadRetained(request.session_id));
    let snapshot =
        result.expect("real Python worker/JSONL must preserve prepare and commit contract");
    assert_eq!(session.record.session_id.as_deref(), Some("retained"));
    assert!(session.record.pending_load.is_none());
    assert_eq!(snapshot.verified_model, Some(IvyModel::Sol));
    let serialized = serde_json::to_value(snapshot).unwrap();
    assert_eq!(serialized, contract["renderer_result"]);
    let audit: Value = serde_json::from_slice(&std::fs::read(audit).unwrap()).unwrap();
    assert_eq!(audit["mutations"], 1);
    assert_eq!(audit["requests"][0]["operation"], "editor_mcp");
    assert_eq!(audit["requests"][0]["revision"], 4);
    assert_eq!(audit["requests"][0]["generation"], 2);
    assert_eq!(
        audit["history"],
        json!(["user question", "original answer"])
    );
    assert!(
        audit["methods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| matches!(
                v.as_str(),
                Some("runtime.describe" | "session.resume" | "session.mutate")
            ))
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn uncertain_serialized_commit_retains_and_reconciles_one_durable_native_intent() {
    let (mut session, directory, audit) = wire(Some("lost-commit-reply"));
    assert!(matches!(
        session.control(Control::LoadRetained("retained".into())),
        Err(IvyErrorCode::Uncertain)
    ));
    let pending = session.record.pending_load.clone().unwrap();
    assert_eq!(session.record.session_id.as_deref(), Some("current"));
    let saved: Record =
        serde_json::from_slice(&std::fs::read(directory.join("ivy-session.json")).unwrap())
            .unwrap();
    assert_eq!(saved.pending_load.unwrap().request_id, pending.request_id);
    session.reconcile().unwrap();
    assert_eq!(session.record.session_id.as_deref(), Some("retained"));
    assert!(session.record.pending_load.is_none());
    let audit: Value = serde_json::from_slice(&std::fs::read(audit).unwrap()).unwrap();
    assert_eq!(audit["mutations"], 1);
    assert_eq!(audit["requests"][0]["request_id"], pending.request_id);
    assert_eq!(
        audit["history"],
        json!(["user question", "original answer"])
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

fn archived_cursor(directory: &std::path::Path) {
    use sha2::{Digest, Sha256};
    let path = directory.join("retained-updates");
    std::fs::create_dir_all(&path).unwrap();
    super::update_store::Updates {
        session: "retained".into(),
        cursor: Some(("epoch".into(), 5)),
        ..Default::default()
    }
    .save(&path.join(format!("{:x}.json", Sha256::digest(b"retained"))))
    .unwrap();
}

#[test]
fn retained_load_replays_missed_admission_before_reporting_success() {
    let (mut session, directory, audit) = wire(Some("replay"));
    archived_cursor(&directory);
    let snapshot = session
        .control(Control::LoadRetained("retained".into()))
        .unwrap();
    let updates =
        super::update_store::Updates::load(&session.journal.updates_path(), "retained").unwrap();
    assert_eq!(
        updates.completed.len(),
        1,
        "missed start must be discovered from retained cursor"
    );
    assert_eq!(updates.completed[0].id, "missed");
    assert_eq!(updates.completed[0].text, "Retained background answer");
    assert_eq!(updates.cursor, Some(("epoch".into(), 6)));
    assert_eq!(snapshot.background_updates.unwrap()[0].id, "missed");
    assert!(session.record.pending_load.is_none());
    let calls: Value = serde_json::from_slice(&std::fs::read(audit).unwrap()).unwrap();
    assert!(
        calls["methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m == "session.events.since")
    );
    assert_eq!(calls["mutations"], 1);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn failed_retained_replay_keeps_same_durable_intent_and_reconciles_one_effect() {
    let (mut session, directory, audit) = wire(Some("replay-fail-once"));
    archived_cursor(&directory);
    assert!(
        session
            .control(Control::LoadRetained("retained".into()))
            .is_err(),
        "replay failure cannot report recovery complete"
    );
    let pending = session.record.pending_load.clone().unwrap();
    let saved: Record =
        serde_json::from_slice(&std::fs::read(directory.join("ivy-session.json")).unwrap())
            .unwrap();
    assert_eq!(saved.pending_load.unwrap().request_id, pending.request_id);
    assert_eq!(saved.session_id.as_deref(), Some("retained"));
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Uncertain
    );
    session.reconcile().unwrap();
    assert!(session.record.pending_load.is_none());
    let updates =
        super::update_store::Updates::load(&session.journal.updates_path(), "retained").unwrap();
    assert_eq!(updates.completed.len(), 1);
    let calls: Value = serde_json::from_slice(&std::fs::read(audit).unwrap()).unwrap();
    assert_eq!(calls["mutations"], 1);
    assert_eq!(calls["requests"][0]["request_id"], pending.request_id);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn retained_replay_preserves_policy_differing_from_normal_access_sync() {
    let (mut session, directory, audit) = wire(Some("policy-preserved"));
    session
        .control(Control::LoadRetained("retained".into()))
        .unwrap();
    let calls: Value = serde_json::from_slice(&std::fs::read(audit).unwrap()).unwrap();
    assert_eq!(calls["mutations"], 1);
    assert_eq!(calls["requests"][0]["operation"], "editor_mcp");
    assert_eq!(calls["policy"], "workspace_session");
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
