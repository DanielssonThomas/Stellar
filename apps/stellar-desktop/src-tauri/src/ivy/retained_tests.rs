#![cfg(windows)]
use super::{
    contracts::*,
    journal::{Journal, WorkspaceDescriptor},
    lifecycle::Control,
    process::Broker,
    session_tests::fixture,
    update_store::Updates,
};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

fn broker(wrong: bool) -> Broker {
    let script = format!(
        r#"
while ($line = [Console]::ReadLine()) {{
 $r = $line | ConvertFrom-Json
 $result = switch ($r.method) {{
  'session.resume' {{ @{{session_id='session';running=$false;pending=@();open_requests=@()}} }}
  'session.load.prepare' {{ @{{session_id='retained';stored_session_id='physical';revision=4;generation=2;model='gpt-6.1-sol';edit_policy='ask'}} }}
  'session.load' {{ if ($r.params.session_id -ne 'retained' -or $r.params.revision -ne 4) {{ exit 4 }}; @{{session_id='retained';stored_session_id='{}';model='gpt-6.1-sol'}} }}
  default {{ exit 2 }}
 }}
 [Console]::WriteLine((@{{id=$r.id;result=$result}} | ConvertTo-Json -Compress -Depth 6))
}}
"#,
        if wrong { "wrong" } else { "physical" }
    );
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap()
}

fn ready(session: &mut super::session::Session, wrong: bool) {
    session.record.unsettled = false;
    session.record.workspace = Some(WorkspaceDescriptor {
        port: 1,
        credential_ref: "a".repeat(32),
    });
    session.broker = Some(broker(wrong));
}

#[test]
fn explicit_load_keeps_target_identity_and_archives_original_notification_journal() {
    let (mut session, directory) = fixture();
    ready(&mut session, false);
    let path = session.journal.updates_path();
    let original = Updates {
        session: "session".into(),
        settled_sequence: 17,
        ..Updates::default()
    };
    original.save(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let view = session
        .control(Control::LoadRetained("retained".into()))
        .unwrap();
    assert_eq!(view.model, IvyModel::Sol);
    assert_eq!(view.verified_model, Some(IvyModel::Sol));
    assert_eq!(session.record.session_id.as_deref(), Some("retained"));
    assert!(session.record.input_id.is_none());
    assert!(session.record.pending_load.is_none());
    assert_eq!(
        Updates::load(&path, "retained").unwrap().session,
        "retained"
    );
    let archived = std::fs::read_dir(directory.join("retained-updates"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read(archived).unwrap(), bytes);
    drop(session);
    let (_, record) = Journal::open(&directory).unwrap();
    assert_eq!(record.session_id.as_deref(), Some("retained"));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn uncertain_load_is_durable_blocks_submit_and_reconciles_same_native_intent() {
    let (mut session, directory) = fixture();
    ready(&mut session, true);
    assert!(matches!(
        session.control(Control::LoadRetained("retained".into())),
        Err(IvyErrorCode::Uncertain)
    ));
    let request = session
        .record
        .pending_load
        .as_ref()
        .unwrap()
        .request_id
        .clone();
    let mut observer = super::observation::Observation::default();
    let now = std::time::Instant::now();
    observer.poll(&mut session, now).unwrap();
    observer
        .poll(&mut session, now + std::time::Duration::from_secs(31))
        .unwrap();
    session.event(serde_json::json!({"event":"gateway","data":{"params":{
        "session_id":"session","admission_id":"admission","execution_generation":3,
        "replay_epoch":"old","seq":99,"type":"message.complete","payload":{"outcome":"completed","text":"old answer"}
    }}})).unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .items
            .is_empty()
    );
    assert_eq!(session.record.session_id.as_deref(), Some("session"));
    session.restore_admission_state();
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Uncertain
    );
    assert!(matches!(
        session.control(Control::NewSession),
        Err(IvyErrorCode::Busy)
    ));
    assert!(matches!(
        session.control(Control::LoadRetained("different".into())),
        Err(IvyErrorCode::Uncertain)
    ));
    session.broker = Some(broker(false));
    session.reconcile().unwrap();
    assert!(session.record.pending_load.is_none());
    assert_eq!(session.record.session_id.as_deref(), Some("retained"));
    assert!(request.starts_with("stellar-load-"));
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn active_or_unknown_notification_work_prevents_load_before_any_bridge_effect() {
    let (mut session, directory) = fixture();
    assert!(matches!(
        session.control(Control::LoadRetained("retained".into())),
        Err(IvyErrorCode::Busy)
    ));
    session.record.unsettled = false;
    Updates {
        session: "session".into(),
        recovery_pending: true,
        ..Updates::default()
    }
    .save(&session.journal.updates_path())
    .unwrap();
    assert!(matches!(
        session.control(Control::LoadRetained("retained".into())),
        Err(IvyErrorCode::Uncertain)
    ));
    assert!(session.record.pending_load.is_none());
    assert!(session.broker.is_none());
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn pending_intent_storage_failure_preserves_original_journal_and_never_commits_load() {
    let (mut session, directory) = fixture();
    ready(&mut session, false);
    let before = std::fs::read(directory.join("ivy-session.json")).unwrap();
    std::fs::create_dir(directory.join("ivy-session.pending")).unwrap();
    assert!(matches!(
        session.control(Control::LoadRetained("retained".into())),
        Err(IvyErrorCode::Storage)
    ));
    assert_eq!(
        std::fs::read(directory.join("ivy-session.json")).unwrap(),
        before
    );
    assert!(session.record.pending_load.is_none());
    assert_eq!(session.record.session_id.as_deref(), Some("session"));
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
