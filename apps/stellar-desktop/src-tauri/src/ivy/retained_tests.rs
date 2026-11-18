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
    broker_fault(wrong, None)
}

fn broker_fault(wrong: bool, fault_path: Option<&std::path::Path>) -> Broker {
    let fault = fault_path
        .map(|path| {
            format!(
                "New-Item -ItemType Directory -Path '{}' -Force | Out-Null;",
                path.display().to_string().replace('\'', "''")
            )
        })
        .unwrap_or_default();
    let script = format!(
        r#"
while ($line = [Console]::ReadLine()) {{
 $r = $line | ConvertFrom-Json
 $result = switch ($r.method) {{
  'session.resume' {{ @{{session_id='session';running=$false;pending=@();open_requests=@();replay_epoch='epoch';last_sequence=5;execution_generation=3}} }}
  'session.load.prepare' {{ @{{session_id='retained';stored_session_id='physical';revision=4;generation=2;model='gpt-6.1-sol';edit_policy='ask'}} }}
  'session.load' {{ {fault} if ($r.params.session_id -ne 'retained' -or $r.params.revision -ne 4) {{ exit 4 }}; @{{session_id='retained';stored_session_id='{}';model='gpt-6.1-sol'}} }}
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

#[test]
fn interrupted_final_save_reconnect_preserves_both_stores_and_their_speech_claims() {
    use sha2::{Digest, Sha256};
    let (mut session, directory) = fixture();
    ready(&mut session, false);
    session.journal.save(&session.record).unwrap();
    let store = |sid: &str, claim: &str| Updates {
        session: sid.into(),
        settled_sequence: 17,
        completed: vec![IvyBackgroundUpdate {
            id: format!("done-{sid}"),
            text: "Retained receipt".into(),
            speech_claim: Some(claim.into()),
        }],
        ..Updates::default()
    };
    let current = session.journal.updates_path();
    store("session", "original-speech-claim")
        .save(&current)
        .unwrap();
    let original = std::fs::read(&current).unwrap();
    let archives = directory.join("retained-updates");
    std::fs::create_dir_all(&archives).unwrap();
    let archive = |sid: &str| archives.join(format!("{:x}.json", Sha256::digest(sid.as_bytes())));
    store("retained", "target-speech-claim")
        .save(&archive("retained"))
        .unwrap();
    let target = std::fs::read(archive("retained")).unwrap();
    session.broker = Some(broker_fault(
        false,
        Some(&directory.join("ivy-session.pending")),
    ));
    assert!(matches!(
        session.control(Control::LoadRetained("retained".into())),
        Err(IvyErrorCode::Storage)
    ));
    assert_eq!(std::fs::read(&current).unwrap(), target);
    let request = session
        .record
        .pending_load
        .as_ref()
        .unwrap()
        .request_id
        .clone();
    drop(session);
    let (journal, record) = Journal::open(&directory).unwrap();
    let (mut recovered, extra) = fixture();
    recovered.journal = journal;
    recovered.record = record;
    recovered.broker = Some(broker(false));
    // Exercise the exact post-workspace initialization path used by normal reconnect.
    super::connection::resume_selected(&mut recovered).unwrap();
    super::connection::publish_ready(&recovered);
    assert_eq!(std::fs::read(&current).unwrap(), target);
    assert_eq!(
        recovered.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Uncertain
    );
    assert_eq!(
        recovered.record.pending_load.as_ref().unwrap().request_id,
        request
    );
    std::fs::remove_dir(directory.join("ivy-session.pending")).unwrap();
    recovered.reconcile().unwrap();
    assert_eq!(std::fs::read(&current).unwrap(), target);
    assert_eq!(std::fs::read(archive("session")).unwrap(), original);
    assert_eq!(std::fs::read(archive("retained")).unwrap(), target);
    assert!(recovered.record.pending_load.is_none());
    drop(recovered);
    std::fs::remove_dir_all(directory).unwrap();
    std::fs::remove_dir_all(extra).unwrap();
}
