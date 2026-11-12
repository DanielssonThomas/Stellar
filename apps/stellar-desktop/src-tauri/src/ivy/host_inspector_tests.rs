use super::*;
use crate::ivy::{journal::Journal, process::Broker};
use serde_json::{Value, json};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
};

fn request() -> IvyInspectorRequest {
    IvyInspectorRequest {
        version: 1,
        session_id: None,
        offset: 0,
        before_message: None,
    }
}

fn gateway(event: Option<Value>) -> (Session, Arc<WorkspaceHub>, std::path::PathBuf) {
    let (mut session, directory) = crate::ivy::session_tests::fixture();
    session.shared.update(1, |view| {
        view.connection = IvyConnectionState::Ready;
        view.workspace_tools = WorkspaceToolsState::Available;
    });
    let frame = event
        .map(|v| format!("[Console]::WriteLine('{}')\n", v))
        .unwrap_or_default();
    let script = format!(
        r#"
$null=[Console]::ReadLine()
{frame}
[Console]::WriteLine('{{"id":1,"result":{{"malformed_metrics":true}}}}')
Start-Sleep -Seconds 5
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
    let tools = Arc::new(WorkspaceHub::new(session.shared.clone()));
    tools.set_input(Some(broker.input()));
    crate::ivy::workspace_data::configure(
        json!({
            "descriptor":{"port":12345,"credential_ref":"0123456789abcdef0123456789abcdef"},
            "image_port":12346,"image_secret":"a".repeat(64)
        }),
        &tools.image_endpoint(),
    )
    .unwrap();
    session.broker = Some(broker);
    (session, tools, directory)
}

#[test]
fn inspector_interleaved_lifecycle_failure_disarms_workspace_and_preserves_uncertainty() {
    for event in [
        json!({"type":"session.replay_gap","session_id":"session"}),
        json!({"type":"message.complete","session_id":"session","admission_id":"admission", "execution_generation":4,
            "replay_epoch":"original","seq":2,"payload":{"outcome":"completed","text":"must not complete"}}),
        json!({"type":"message.complete","session_id":"session","admission_id":"admission", "execution_generation":3,
            "replay_epoch":"changed","seq":2,"payload":{"outcome":"completed","text":"must not complete"}}),
    ] {
        let (mut session, tools, directory) =
            gateway(Some(json!({"event":"gateway","data":{"params":event}})));
        session.replay = Some(("original".into(), 1));
        let (sender, reply) = mpsc::sync_channel(1);
        let outcome = run(&mut session, request(), sender);
        assert_eq!(outcome, Err(IvyErrorCode::Uncertain));
        assert_eq!(reply.recv().unwrap().unwrap_err(), IvyErrorCode::Uncertain);
        super::super::settle_result(&mut session, &tools, outcome);
        let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
        assert_eq!(snapshot.turn, IvyTurnState::Uncertain);
        assert_eq!(snapshot.workspace_tools, WorkspaceToolsState::Unavailable);
        assert_eq!(snapshot.connection, IvyConnectionState::Unavailable);
        assert!(tools.image_endpoint().lock().unwrap().is_none());
        assert!(session.record.unsettled);
        assert!(session.broker.is_none());
        drop(session);
        assert!(Journal::open(&directory).unwrap().1.unsettled);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn malformed_inspector_metrics_do_not_kill_a_valid_running_turn() {
    let (mut session, tools, directory) = gateway(None);
    let (sender, reply) = mpsc::sync_channel(1);
    let outcome = run(&mut session, request(), sender);
    assert_eq!(outcome, Ok(()));
    assert_eq!(reply.recv().unwrap().unwrap_err(), IvyErrorCode::Protocol);
    super::super::settle_result(&mut session, &tools, outcome);
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(snapshot.turn, IvyTurnState::Admitted);
    assert_eq!(snapshot.connection, IvyConnectionState::Ready);
    assert_eq!(snapshot.workspace_tools, WorkspaceToolsState::Available);
    assert!(tools.image_endpoint().lock().unwrap().is_some());
    assert!(session.broker.is_some());
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
