#![cfg(windows)]
use super::{
    contracts::*, journal::Journal, lifecycle::Control, process::Broker, session_tests::fixture,
};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

fn broker(fresh: bool) -> Broker {
    let script = format!(
        r#"
$resumed = $false
while ($line = [Console]::ReadLine()) {{
  $r = $line | ConvertFrom-Json
  $result = switch ($r.method) {{
    'session.resume' {{ $resumed = $true; @{{session_id='session';model='gpt-6.1-terra';running=$false;pending=@();revision=8;execution_generation=3}} }}
    'session.new' {{ if (-not $resumed) {{ exit 3 }}; @{{status='{}';execution_generation=4}} }}
    'integrations.reload' {{ @{{status='reloaded'}} }}
    default {{ exit 2 }}
  }}
  [Console]::WriteLine((@{{id=$r.id;result=$result}} | ConvertTo-Json -Compress -Depth 6))
}}
"#,
        if fresh { "fresh" } else { "unconfirmed" }
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

#[test]
fn native_reset_keeps_policy_and_fences_old_admissions() {
    let (mut session, directory) = fixture();
    session.record.unsettled = false;
    session.broker = Some(broker(true));
    let snapshot = session.control(Control::NewSession).unwrap();
    assert_eq!(snapshot.turn, IvyTurnState::Idle);
    assert!(snapshot.reset_id.is_some());
    assert_eq!(session.record.session_id.as_deref(), Some("session"));
    assert_eq!(session.record.model, IvyModel::Terra);
    assert!(session.record.input_id.is_none());
    assert!(session.record.admission_id.is_none());
    assert!(session.record.pending_reset.is_none());
    assert!(session.broker.is_some());
    session
        .event(serde_json::json!({"event":"gateway","data":{"params":{
            "session_id":"session", "admission_id":"admission", "execution_generation":3,
            "replay_epoch":"old", "seq":99, "type":"message.complete",
            "payload":{"outcome":"completed", "text":"old conversation"}
        }}}))
        .unwrap();
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
    drop(session);
    assert!(Journal::open(&directory).unwrap().1.pending_reset.is_none());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn unconfirmed_reset_is_durable_and_blocks_submissions() {
    let (mut session, directory) = fixture();
    session.record.unsettled = false;
    session.broker = Some(broker(false));
    assert!(matches!(
        session.control(Control::NewSession),
        Err(IvyErrorCode::Uncertain)
    ));
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Uncertain
    );
    let request = session
        .record
        .pending_reset
        .as_ref()
        .unwrap()
        .request_id
        .clone();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .reset_id
            .is_none()
    );
    assert!(matches!(
        session.control(Control::ReloadMcp),
        Err(IvyErrorCode::Busy)
    ));
    session.broker = Some(broker(true));
    session.reconcile().unwrap();
    assert!(session.record.pending_reset.is_none());
    assert!(!request.is_empty());
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn controls_refuse_active_execution() {
    let (mut session, directory) = fixture();
    assert!(matches!(
        session.control(Control::NewSession),
        Err(IvyErrorCode::Busy)
    ));
    assert!(matches!(
        session.control(Control::ReloadMcp),
        Err(IvyErrorCode::Busy)
    ));
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
