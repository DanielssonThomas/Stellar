use super::{
    contracts::*,
    journal::{Journal, Record},
    session::Session,
    state::{Shared, View},
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

fn fixture() -> (Session, std::path::PathBuf) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "stellar-ivy-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let (journal, _) = Journal::open(&directory).unwrap();
    let record = Record {
        session_id: Some("session".into()),
        input_id: Some("00000000-0000-0000-0000-000000000001".into()),
        admission_id: Some("admission".into()),
        generation: Some(3),
        unsettled: true,
    };
    journal.save(&record).unwrap();
    let shared = Shared {
        view: Arc::new(Mutex::new(View {
            epoch: 1,
            snapshot: IvySnapshot {
                turn: IvyTurnState::Admitted,
                ..IvySnapshot::default()
            },
        })),
        publish: Arc::new(|_| {}),
    };
    (
        Session {
            journal,
            record,
            broker: None,
            shared,
            epoch: 1,
            buffered: vec![],
            replay: None,
        },
        directory,
    )
}

fn completion(admission: &str, generation: u64, text: &str) -> serde_json::Value {
    json!({"event":"gateway","data":{"params":{"type":"message.complete","session_id":"session","admission_id":admission,
        "execution_generation":generation,"replay_epoch":"epoch","seq":1,"payload":{"outcome":"completed","text":text}}}})
}

#[test]
fn only_bound_completion_settles_and_replay_does_not_replace_answer() {
    let (mut session, directory) = fixture();
    session.event(completion("foreign", 3, "wrong")).unwrap();
    assert!(session.record.unsettled);
    session.event(completion("admission", 3, "answer")).unwrap();
    assert!(!session.record.unsettled);
    let original = session.shared.view.lock().unwrap().snapshot.items.clone();
    session
        .event(completion("admission", 3, "duplicate changed bytes"))
        .unwrap();
    assert_eq!(session.shared.view.lock().unwrap().snapshot.items, original);
    drop(session);
    assert!(!Journal::open(&directory).unwrap().1.unsettled);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn wrong_generation_and_replay_gap_preserve_uncertainty() {
    let (mut session, directory) = fixture();
    assert_eq!(
        session.event(completion("admission", 4, "wrong")),
        Err(IvyErrorCode::Uncertain)
    );
    assert!(session.record.unsettled);
    assert_eq!(session.event(json!({"event":"gateway","data":{"params":{"type":"session.replay_gap","session_id":"session"}}})), Err(IvyErrorCode::Uncertain));
    drop(session);
    assert!(Journal::open(&directory).unwrap().1.unsettled);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn journal_excludes_second_owner_and_retains_unknown_attempt() {
    let (session, directory) = fixture();
    assert!(matches!(Journal::open(&directory), Err(IvyErrorCode::Busy)));
    drop(session);
    let (journal, record) = Journal::open(&directory).unwrap();
    assert!(record.unsettled);
    assert_eq!(record.admission_id.as_deref(), Some("admission"));
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn malformed_user_turns_cannot_be_admitted() {
    let mut request = IvySubmitRequest {
        version: 1,
        input_id: "00000000-0000-0000-0000-000000000001".into(),
        text: "Hello".into(),
    };
    assert!(super::host::validate_submit(&request).is_ok());
    request.input_id = "../../profile".into();
    assert_eq!(
        super::host::validate_submit(&request),
        Err(IvyErrorCode::MalformedRequest)
    );
    request.input_id = "00000000-0000-0000-0000-000000000001".into();
    request.text = "é".repeat(4097);
    assert_eq!(
        super::host::validate_submit(&request),
        Err(IvyErrorCode::MalformedRequest)
    );
}

#[cfg(windows)]
fn inert_broker(terminal: bool) -> super::process::Broker {
    inert_outcome(terminal, "completed", "canonical recovered answer")
}

#[cfg(windows)]
fn inert_outcome(terminal: bool, outcome: &str, text: &str) -> super::process::Broker {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let template = r#"
while ($line = [Console]::ReadLine()) {
  $request = $line | ConvertFrom-Json
  $receipt = @{ref=@{session_id='session'};admission_id='admission';execution_generation=3;status='STATUS';outcome='OUTCOME';result=@{final_response='FINAL_TEXT'}}
  $result = switch ($request.method) {
    'session.create' { @{session_id='session'} }
    'prompt.submit' { $receipt }
    'session.resume' { @{session_id='session';pending=@(@{ref=@{session_id='session'};admission_id='admission';execution_generation=3;input_id='00000000-0000-0000-0000-000000000001'})} }
    'prompt.receipt' { $receipt }
    'session.interrupt' { @{execution_generation=3;execution_state='running'} }
    default { @{unexpected=$true} }
  }
  if ($request.method -eq 'prompt.submit') {
    [Console]::WriteLine('{"event":"gateway","data":{"params":{"type":"message.complete","session_id":"session","admission_id":"admission","execution_generation":3,"replay_epoch":"epoch","seq":1,"payload":{"outcome":"completed","text":"early complete"}}}}')
  }
  [Console]::WriteLine((@{id=$request.id;result=$result}|ConvertTo-Json -Compress -Depth 6))
}
"#;
    let script = template
        .replace("STATUS", if terminal { "terminal" } else { "started" })
        .replace("OUTCOME", outcome)
        .replace("FINAL_TEXT", text);
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    super::process::Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap()
}

#[cfg(windows)]
#[test]
fn unknown_receipt_is_reconciled_from_pending_identity_without_resubmission() {
    let (mut session, directory) = fixture();
    session.record.admission_id = None;
    session.broker = Some(inert_broker(true));
    session.reconcile().unwrap();
    assert!(!session.record.unsettled);
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Completed
    );
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.items,
        vec![super::presentation::IvyPresentation::Text {
            text: "canonical recovered answer".into()
        }]
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(windows)]
#[test]
fn cancellation_acknowledgement_is_not_terminal_completion() {
    let (mut session, directory) = fixture();
    session.broker = Some(inert_broker(false));
    session.cancel().unwrap();
    assert!(session.record.unsettled);
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Admitted
    );
    drop(session);
    assert!(Journal::open(&directory).unwrap().1.unsettled);
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(windows)]
#[test]
fn completion_before_admission_reply_is_bound_after_the_receipt() {
    let (mut session, directory) = fixture();
    session.record = Record::default();
    session.broker = Some(inert_broker(false));
    session
        .submit(IvySubmitRequest {
            version: 1,
            input_id: "00000000-0000-0000-0000-000000000002".into(),
            text: "explicit fixture request".into(),
        })
        .unwrap();
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Completed
    );
    assert!(!session.record.unsettled);
    assert_eq!(
        session.record.input_id.as_deref(),
        Some("00000000-0000-0000-0000-000000000002")
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn canonical_failed_and_empty_cancelled_events_settle_without_invalid_text() {
    for (outcome, expected) in [
        ("failed", IvyTurnState::Failed),
        ("cancelled", IvyTurnState::Cancelled),
    ] {
        let (mut session, directory) = fixture();
        let mut event = completion("admission", 3, " \n\t");
        event["data"]["params"]["payload"]["outcome"] = outcome.into();
        session.event(event).unwrap();
        let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
        assert_eq!(snapshot.turn, expected);
        assert!(snapshot.items.is_empty());
        assert_eq!(
            snapshot.error,
            if outcome == "failed" {
                Some(IvyErrorCode::TurnFailed)
            } else {
                None
            }
        );
        drop(session);
        assert!(!Journal::open(&directory).unwrap().1.unsettled);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn terminal_failed_and_empty_cancelled_receipts_release_the_logical_turn() {
    for (outcome, expected) in [
        ("failed", IvyTurnState::Failed),
        ("cancelled", IvyTurnState::Cancelled),
    ] {
        let (mut session, directory) = fixture();
        session.broker = Some(inert_outcome(true, outcome, ""));
        session.reconcile().unwrap();
        let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
        assert_eq!(snapshot.turn, expected);
        assert!(snapshot.items.is_empty());
        drop(session);
        assert!(!Journal::open(&directory).unwrap().1.unsettled);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
