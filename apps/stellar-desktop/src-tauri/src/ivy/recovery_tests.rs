#![cfg(windows)]
use super::{
    contracts::*,
    journal::{Journal, Record},
    process::Broker,
    session::Session,
    state::{Shared, View},
};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

pub(super) fn fixture(receipt: &str) -> (Session, std::path::PathBuf) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "stellar-recovery-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let (journal, _) = Journal::open(&directory).unwrap();
    let record = Record {
        session_id: Some("session".into()),
        input_id: Some("00000000-0000-0000-0000-000000000001".into()),
        admission_id: Some("admission".into()),
        generation: Some(3),
        unsettled: true,
        model: IvyModel::Terra,
        route_verified: true,
        workspace: None,
        pending_reset: None,
    };
    journal.save(&record).unwrap();
    let shared = Shared {
        view: Arc::new(Mutex::new(View {
            epoch: 1,
            snapshot: IvySnapshot {
                turn: IvyTurnState::Uncertain,
                ..IvySnapshot::default()
            },
        })),
        publish: Arc::new(|_| {}),
    };
    let script = format!(
        r#"
while ($line = [Console]::ReadLine()) {{
  $request = $line | ConvertFrom-Json
  $result = if ($request.method -eq 'session.resume') {{ @{{session_id='session';pending=@();replay_epoch='replay';last_sequence=0}} }} elseif ($request.method -eq 'session.events.since') {{ @{{events=@();truncated=$false;replay_epoch='replay';last_sequence=10}} }} elseif ($request.method -eq 'prompt.receipt') {{ {receipt} }} else {{ exit 2 }}
  [Console]::WriteLine((@{{id=$request.id;result=$result}} | ConvertTo-Json -Compress -Depth 8))
}}
"#
    );
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let broker = Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap();
    (
        Session {
            journal,
            record,
            broker: Some(broker),
            shared,
            epoch: 1,
            workspace_epoch: 1,
            buffered: vec![],
            replay: None,
        },
        directory,
    )
}

#[test]
fn known_terminal_receipt_settles_without_resubmitting() {
    let (mut session, directory) = fixture(
        "@{ref=@{session_id='session'};admission_id='admission';execution_generation=3;status='terminal';outcome='completed';result=@{final_response='Recovered'}}",
    );
    session.reconcile().unwrap();
    assert!(!session.record.unsettled);
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.turn,
        IvyTurnState::Completed
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn mismatched_generation_or_missing_completed_result_retains_uncertainty() {
    for (receipt, expected) in [
        (
            "@{ref=@{session_id='foreign'};admission_id='admission';execution_generation=3;status='terminal';outcome='completed';result=@{final_response='wrong'}}",
            IvyErrorCode::Protocol,
        ),
        (
            "@{ref=@{session_id='session'};admission_id='foreign';execution_generation=3;status='terminal';outcome='completed';result=@{final_response='wrong'}}",
            IvyErrorCode::Protocol,
        ),
        (
            "@{ref=@{session_id='session'};admission_id='admission';execution_generation=4;status='terminal';outcome='completed';result=@{final_response='wrong'}}",
            IvyErrorCode::Uncertain,
        ),
        (
            "@{ref=@{session_id='session'};admission_id='admission';execution_generation=3;status='terminal';outcome='completed'}",
            IvyErrorCode::Protocol,
        ),
    ] {
        let (mut session, directory) = fixture(receipt);
        assert_eq!(session.reconcile(), Err(expected));
        assert!(session.record.unsettled);
        assert_eq!(session.record.generation, Some(3));
        drop(session);
        assert!(Journal::open(&directory).unwrap().1.unsettled);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn missing_unknown_admission_is_never_guessed() {
    let (mut session, directory) = fixture("@{unexpected=$true}");
    session.record.admission_id = None;
    session.record.generation = None;
    session.journal.save(&session.record).unwrap();
    assert_eq!(session.reconcile(), Err(IvyErrorCode::Uncertain));
    assert!(session.record.unsettled);
    assert!(session.record.admission_id.is_none());
    drop(session);
    assert!(Journal::open(&directory).unwrap().1.unsettled);
    std::fs::remove_dir_all(directory).unwrap();
}
