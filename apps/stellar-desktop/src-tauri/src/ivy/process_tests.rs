use super::*;

#[test]
fn maximum_question_answers_fit_the_json_envelope_without_widening_prompt_limits() {
    let params = json!({"session_id":"s".repeat(512),"execution_generation":u64::MAX,"prompt_id":"q".repeat(512),"answer":"\"".repeat(16384)});
    let line = request_line(u64::MAX, "clarify.respond", &params).unwrap();
    assert!(line.len() > 16384 && line.len() <= 65536);
    assert_eq!(
        serde_json::from_slice::<Value>(&line).unwrap()["params"],
        params
    );
    assert_eq!(
        request_line(1, "prompt.submit", &params),
        Err(IvyErrorCode::MalformedRequest)
    );
    assert_eq!(
        request_line(1, "clarify.respond", &json!({"answer":"\"".repeat(65536)})),
        Err(IvyErrorCode::MalformedRequest)
    );
}

fn fixture(script: &str) -> Broker {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
    Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap()
}

#[test]
fn inert_child_reply_is_correlated_and_owned_process_is_reaped() {
    let mut broker = fixture(
        "$null=[Console]::ReadLine(); [Console]::WriteLine('{\"id\":1,\"result\":{\"pong\":true}}'); Start-Sleep 5",
    );
    let child = broker.child.clone();
    assert_eq!(
        broker.call("ping", json!({}), &mut vec![]).unwrap(),
        json!({"pong":true})
    );
    assert!(child.lock().unwrap().is_some());
    drop(broker);
    assert!(child.lock().unwrap().is_none());
}

#[test]
fn malformed_and_foreign_child_frames_fail_closed() {
    for script in [
        "$null=[Console]::ReadLine(); [Console]::WriteLine('not json')",
        "$null=[Console]::ReadLine(); [Console]::WriteLine('{\"id\":9,\"result\":{}}')",
        "$null=[Console]::ReadLine(); [Console]::WriteLine(('x' * 65537))",
    ] {
        let mut broker = fixture(script);
        assert!(matches!(
            broker.call("ping", json!({}), &mut vec![]),
            Err(IvyErrorCode::Protocol)
        ));
    }
}

#[test]
fn long_completion_frame_is_preserved_without_a_transport_size_ceiling() {
    let mut broker = fixture(
        "$null=[Console]::ReadLine(); [Console]::WriteLine(('{\"id\":1,\"result\":{\"text\":\"' + ('a' * 200000) + '\"}}'))",
    );
    let response = broker.call("ping", json!({}), &mut vec![]).unwrap();
    assert_eq!(response["text"].as_str().unwrap(), "a".repeat(200000));
}

#[test]
fn stalled_child_has_a_deadline_and_no_resubmission() {
    let mut broker = fixture("$null=[Console]::ReadLine(); Start-Sleep 5");
    broker.deadline = Duration::from_millis(30);
    assert!(matches!(
        broker.call("ping", json!({}), &mut vec![]),
        Err(IvyErrorCode::Timeout)
    ));
    assert_eq!(broker.sequence, 1);
}

#[test]
#[ignore = "Explicit local no-inference Ivy health verification; CI must never contact the personal profile"]
fn installed_gateway_silent_health() {
    let mut broker = Broker::launch(Arc::new(Mutex::new(None))).unwrap();
    let mut events = vec![];
    assert_eq!(
        broker.call("ping", json!({}), &mut events).unwrap(),
        json!({"pong":true})
    );
    let description = broker
        .call("runtime.describe", json!({}), &mut events)
        .unwrap();
    assert_eq!(description["profile"], "ivy");
    assert_eq!(description["protocol"], 1);
    assert_eq!(broker.sequence, 2);
}
