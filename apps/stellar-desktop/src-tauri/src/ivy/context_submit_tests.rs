use super::{
    contracts::IvySubmitRequest, process::Broker, session_tests::fixture,
    workspace_context::ContextLease,
};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[test]
fn context_resolution_waits_until_after_session_resume_and_preserves_paused_request() {
    for (paused, cancel) in [(false, false), (true, false), (false, true)] {
        let (mut session, directory) = fixture();
        session.record.unsettled = false;
        session.record.input_id = None;
        session.record.admission_id = None;
        session.record.generation = None;
        let resumed = Arc::new(AtomicBool::new(false));
        let observed = resumed.clone();
        let shared = session.shared.clone();
        let lease: ContextLease = Arc::new(move || {
            assert!(
                observed.load(Ordering::Acquire),
                "context was copied before blocking resume completed"
            );
            if cancel {
                shared.view.lock().unwrap().snapshot.workspace_epoch = "2".into();
            }
            (!paused).then(|| r#"{"foreground":{"app":"fresh.exe"}}"#.into())
        });
        let captured = Arc::new(Mutex::new(String::new()));
        let script = r#"
while ($line = [Console]::ReadLine()) {
  $request = $line | ConvertFrom-Json
  if ($request.method -eq 'session.resume') {
    [Console]::WriteLine('{"event":"workspace_tool","resume_wait":true}')
    $result = @{session_id='session';model='gpt-6.1-terra'}
  } elseif ($request.method -eq 'prompt.submit') {
    [Console]::WriteLine((@{event='workspace_tool';captured_text=$request.params.text;observation=$request.params.observation}|ConvertTo-Json -Compress -Depth 5))
    $result = @{ref=@{session_id='session'};admission_id='admission';execution_generation=3}
  } else { $result = @{} }
  [Console]::WriteLine((@{id=$request.id;result=$result}|ConvertTo-Json -Compress -Depth 6))
}
"#;
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        let mut broker = Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap();
        let copy = captured.clone();
        broker.set_workspace(
            Arc::new(move |frame| {
                if frame
                    .get("resume_wait")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    resumed.store(true, Ordering::Release);
                }
                if let Some(text) = frame
                    .get("captured_text")
                    .and_then(serde_json::Value::as_str)
                {
                    assert_eq!(text, "Keep this original request");
                    *copy.lock().unwrap() = frame["observation"].to_string();
                }
                Ok(())
            }),
            Arc::new(Mutex::new(None)),
        );
        session.broker = Some(broker);
        session
            .submit_with_context(
                IvySubmitRequest {
                    voice_utterance: None,
                    local_actions: None,
                    version: 1,
                    input_id: "00000000-0000-0000-0000-000000000002".into(),
                    text: "Keep this original request".into(),
                },
                Some(lease),
                cancel.then(crate::speech::VoiceExpressionPending::empty_for_test),
            )
            .unwrap();
        let observation = captured.lock().unwrap().clone();
        if cancel {
            assert!(observation.is_empty());
            assert!(!session.record.unsettled);
            assert_eq!(
                session.shared.view.lock().unwrap().snapshot.turn,
                super::contracts::IvyTurnState::Cancelled
            );
        } else {
            assert!(!observation.is_empty());
            assert_eq!(observation.contains("fresh.exe"), !paused);
        }
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
