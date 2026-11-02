use super::*;

fn fixture() -> (IvyHost, mpsc::Receiver<Work>) {
    let shared = Shared {
        view: Arc::new(Mutex::new(View {
            epoch: 0,
            snapshot: IvySnapshot::default(),
        })),
        publish: Arc::new(|_| {}),
    };
    let (sender, receiver) = mpsc::sync_channel(4);
    let workspace = Arc::new(WorkspaceHub::new(shared.clone()));
    (
        IvyHost {
            shared,
            child: Arc::new(Mutex::new(None)),
            sender,
            gate: Mutex::new(()),
            pending_rotation: Arc::new(Mutex::new(None)),
            workspace,
        },
        receiver,
    )
}

#[test]
fn repeated_connect_enqueues_one_silent_operation() {
    let (host, receiver) = fixture();
    host.request(Action::Connect).unwrap();
    host.request(Action::Connect).unwrap();
    assert!(matches!(
        receiver.try_recv().unwrap().action,
        Action::Connect
    ));
    assert!(receiver.try_recv().is_err());
    assert_eq!(
        host.snapshot().unwrap().connection,
        IvyConnectionState::Connecting
    );
}

#[test]
fn cancellation_revokes_workspace_generation_without_disconnect_or_turn_replay() {
    let (host, _receiver) = fixture();
    host.shared
        .update(0, |view| view.connection = IvyConnectionState::Ready);
    let turn = "00000000-0000-4000-8000-000000000001";
    let before = host
        .request(Action::Submit(IvySubmitRequest {
            version: 1,
            input_id: turn.into(),
            text: "hello".into(),
        }))
        .unwrap();
    let after = host.request(Action::Cancel).unwrap();
    assert_eq!(after.connection, IvyConnectionState::Ready);
    assert_eq!(after.turn_id.as_deref(), Some(turn));
    assert_ne!(before.workspace_epoch, after.workspace_epoch);
    let old = json!({"event":"workspace_tool","data":{"version":1,
        "request_id":"0123456789abcdef0123456789abcdef","epoch":before.workspace_epoch,
        "turn_id":turn,"operation":{"kind":"clear"}}});
    assert_eq!(host.workspace.handle(old), Ok(()));
    assert_eq!(
        host.snapshot().unwrap().workspace_tools,
        WorkspaceToolsState::Unavailable
    );
}

#[cfg(windows)]
#[test]
fn early_workspace_callback_can_read_snapshot_and_reply_during_admission() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let (host, _receiver) = fixture();
    let host = Arc::new(host);
    let turn = "00000000-0000-4000-8000-000000000001";
    host.shared.update(0, |view| {
        view.connection = IvyConnectionState::Ready;
        view.turn = IvyTurnState::Submitting;
        view.turn_id = Some(turn.into());
    });
    let script = r#"
$null=[Console]::ReadLine()
[Console]::WriteLine('{"event":"workspace_tool","data":{"version":1,"request_id":"0123456789abcdef0123456789abcdef","epoch":"0","turn_id":"00000000-0000-4000-8000-000000000001","operation":{"kind":"clear"}}}')
$reply=[Console]::ReadLine() | ConvertFrom-Json
if ($reply.control -eq 'workspace_reply' -and $reply.reply.outcome.kind -eq 'applied') { [Console]::WriteLine('{"id":1,"result":{"admitted":true}}') }
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let mut broker = Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap();
    host.workspace.set_input(Some(broker.input()));
    let weak = Arc::downgrade(&host);
    host.set_workspace_publisher(Arc::new(move |request| {
        let host = weak.upgrade().unwrap();
        assert_eq!(host.snapshot().unwrap().turn, IvyTurnState::Submitting);
        host.workspace_reply(WorkspaceToolReply {
            version: 1,
            request_id: request.request_id,
            epoch: request.epoch,
            turn_id: request.turn_id,
            outcome: super::super::workspace_contracts::WorkspaceToolOutcome::Applied,
        })
        .unwrap();
        true
    }));
    let hub = host.workspace.clone();
    broker.set_workspace(
        Arc::new(move |frame| hub.handle(frame)),
        host.workspace.image_endpoint(),
    );
    assert_eq!(
        broker
            .call("prompt.submit", json!({}), &mut vec![])
            .unwrap(),
        json!({"admitted":true})
    );
    assert_eq!(
        host.snapshot().unwrap().workspace_tools,
        WorkspaceToolsState::Available
    );
}

#[cfg(windows)]
#[test]
fn early_window_capture_uses_private_binary_reply_during_admission() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let (host, _receiver) = fixture();
    let host = Arc::new(host);
    host.shared.update(0, |view| {
        view.connection = IvyConnectionState::Ready;
        view.turn = IvyTurnState::Submitting;
        view.turn_id = Some("00000000-0000-4000-8000-000000000001".into());
    });
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    super::super::workspace_data::configure(
        json!({
            "descriptor":{"port":12345,"credential_ref":"0123456789abcdef0123456789abcdef"},
            "image_port":listener.local_addr().unwrap().port(),"image_secret":"a".repeat(64)
        }),
        &host.workspace.image_endpoint(),
    )
    .unwrap();
    let script = r#"
$null=[Console]::ReadLine()
[Console]::WriteLine('{"event":"workspace_tool","data":{"version":1,"request_id":"0123456789abcdef0123456789abcdef","epoch":"0","turn_id":"00000000-0000-4000-8000-000000000001","operation":{"kind":"capture_window"}}}')
$reply=[Console]::ReadLine() | ConvertFrom-Json
if ($reply.control -eq 'test_ack') { [Console]::WriteLine('{"id":1,"result":{"captured":true}}') }
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let mut broker = Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap();
    host.workspace.set_input(Some(broker.input()));
    host.set_workspace_capture(Arc::new(|| Ok(b"\x89PNG\r\n\x1a\nx".to_vec())));
    let control = broker.input();
    let image_receiver = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let header: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(header["secret"], "a".repeat(64));
        assert_eq!(header["size"], 9);
        let mut image = [0; 9];
        reader.read_exact(&mut image).unwrap();
        assert_eq!(&image, b"\x89PNG\r\n\x1a\nx");
        reader.get_mut().write_all(&[1]).unwrap();
        super::super::process::control(&control, &json!({"control":"test_ack"})).unwrap();
    });
    let hub = host.workspace.clone();
    broker.set_workspace(
        Arc::new(move |frame| hub.handle(frame)),
        host.workspace.image_endpoint(),
    );
    assert_eq!(
        broker
            .call("prompt.submit", json!({}), &mut vec![])
            .unwrap(),
        json!({"captured":true})
    );
    image_receiver.join().unwrap();
}

#[test]
fn failed_route_validation_revokes_verification_through_reconnect() {
    let (host, _receiver) = fixture();
    let directory =
        std::env::temp_dir().join(format!("stellar-ivy-verification-{}", std::process::id()));
    let (journal, record) = Journal::open(&directory).unwrap();
    let mut session = Session {
        journal,
        record,
        broker: None,
        shared: host.shared.clone(),
        epoch: 0,
        workspace_epoch: 0,
        buffered: vec![],
        replay: None,
    };
    host.shared.update(0, |view| {
        view.model = IvyModel::Sol;
        view.verified_model = Some(IvyModel::Sol);
        view.turn = IvyTurnState::Submitting;
    });
    fail(&mut session, IvyErrorCode::Unavailable);
    let failed = host.snapshot().unwrap();
    assert_eq!(failed.model, IvyModel::Sol);
    assert_eq!(failed.verified_model, None);
    publish_ready(&session);
    let reconnected = host.snapshot().unwrap();
    assert_eq!(reconnected.connection, IvyConnectionState::Ready);
    assert_eq!(reconnected.verified_model, None);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn disconnect_cancels_rotation_queued_behind_slow_connect_without_waiting() {
    let (host, receiver) = fixture();
    host.request(Action::Connect).unwrap();
    let slow_connect = receiver.try_recv().unwrap();
    let rotation = host.rotate(IvyModel::Sol, false).unwrap();
    let queued = receiver.try_recv().unwrap();
    let started = Instant::now();
    host.request(Action::Cancel).unwrap();
    host.request(Action::Disconnect).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!host.shared.current(slow_connect.epoch));
    if let Action::Rotate(_, _, ticket, reply) = queued.action {
        assert!(!rotation::start(&ticket));
        drop(reply);
    } else {
        panic!("expected rotation");
    }
    assert!(matches!(rotation.wait(), Err(IvyErrorCode::Unavailable)));
    assert_eq!(host.snapshot().unwrap().model, IvyModel::Terra);
}

#[test]
fn timed_out_queued_rotation_cannot_start_later() {
    let (host, receiver) = fixture();
    let rotation = host.rotate(IvyModel::Sol, false).unwrap();
    let queued = receiver.try_recv().unwrap();
    assert!(matches!(rotation.wait(), Err(IvyErrorCode::Timeout)));
    if let Action::Rotate(_, _, ticket, _) = queued.action {
        assert!(!rotation::start(&ticket));
    } else {
        panic!("expected rotation");
    }
    assert_eq!(host.snapshot().unwrap().model, IvyModel::Terra);
}

#[test]
fn started_rotation_remains_busy_until_settled_after_disconnect() {
    let (host, receiver) = fixture();
    let rotation = host.rotate(IvyModel::Sol, false).unwrap();
    let queued = receiver.try_recv().unwrap();
    let Action::Rotate(model, force, ticket, reply) = queued.action else {
        panic!("expected rotation")
    };
    assert!(rotation::start(&ticket));
    host.request(Action::Disconnect).unwrap();
    assert!(matches!(host.snapshot(), Err(IvyErrorCode::Busy)));
    let directory =
        std::env::temp_dir().join(format!("stellar-ivy-rotation-{}", std::process::id()));
    let (journal, record) = Journal::open(&directory).unwrap();
    let mut session = Session {
        journal,
        record,
        broker: None,
        shared: host.shared.clone(),
        epoch: queued.epoch,
        workspace_epoch: queued.workspace_epoch,
        buffered: vec![],
        replay: None,
    };
    session.rotate(model, force).unwrap();
    rotation::finish(&host.pending_rotation, &ticket);
    reply.send(Ok(host.snapshot().unwrap())).unwrap();
    assert_eq!(rotation.wait().unwrap().model, IvyModel::Sol);
    assert_eq!(host.snapshot().unwrap().model, IvyModel::Sol);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn timed_out_started_rotation_stays_busy_until_its_result_is_known() {
    let (host, receiver) = fixture();
    let rotation = host.rotate(IvyModel::Sol, false).unwrap();
    let queued = receiver.try_recv().unwrap();
    let Action::Rotate(_, _, ticket, _reply) = queued.action else {
        panic!("expected rotation")
    };
    assert!(rotation::start(&ticket));
    assert!(matches!(rotation.wait(), Err(IvyErrorCode::Uncertain)));
    assert!(matches!(host.snapshot(), Err(IvyErrorCode::Busy)));
    rotation::finish(&host.pending_rotation, &ticket);
    assert_eq!(host.snapshot().unwrap().model, IvyModel::Terra);
}

#[test]
fn queue_pressure_does_not_invalidate_a_live_owner() {
    let (host, _receiver) = fixture();
    for _ in 0..4 {
        host.request(Action::Cancel).unwrap();
    }
    assert!(matches!(
        host.request(Action::Disconnect),
        Err(IvyErrorCode::Busy)
    ));
    assert_eq!(host.shared.view.lock().unwrap().epoch, 0);
}

#[test]
fn disconnect_fences_pending_connection_results() {
    let (host, _receiver) = fixture();
    host.request(Action::Connect).unwrap();
    let old = host.shared.view.lock().unwrap().epoch;
    host.request(Action::Disconnect).unwrap();
    host.shared
        .update(old, |view| view.connection = IvyConnectionState::Ready);
    assert_eq!(
        host.snapshot().unwrap().connection,
        IvyConnectionState::Disconnected
    );
}

#[cfg(windows)]
#[test]
fn shutdown_reaps_only_the_owned_child_and_fences_pending_work() {
    use std::{os::windows::process::CommandExt, process::Command};
    let spawn = || {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 10",
            ])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap()
    };
    let (host, _) = fixture();
    *host.child.lock().unwrap() = Some(spawn());
    let mut unrelated = spawn();
    let old = host.shared.view.lock().unwrap().epoch;
    host.shutdown();
    assert!(host.child.lock().unwrap().is_none());
    assert!(!host.shared.current(old));
    let unrelated_alive = unrelated.try_wait().unwrap().is_none();
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    assert!(unrelated_alive);
    host.shutdown();
    assert!(host.child.lock().unwrap().is_none());
}

#[test]
fn uncertain_turns_cannot_be_resubmitted_under_a_new_id() {
    let (host, _receiver) = fixture();
    {
        let mut view = host.shared.view.lock().unwrap();
        view.snapshot.connection = IvyConnectionState::Ready;
        view.snapshot.turn = IvyTurnState::Uncertain;
    }
    let request = IvySubmitRequest {
        version: 1,
        input_id: "00000000-0000-0000-0000-000000000001".into(),
        text: "explicit user text".into(),
    };
    assert!(matches!(
        host.request(Action::Submit(request)),
        Err(IvyErrorCode::Busy)
    ));
}

#[test]
fn disconnected_queued_submit_restores_the_unadmitted_journal_state() {
    let (host, receiver) = fixture();
    host.shared.view.lock().unwrap().snapshot.connection = IvyConnectionState::Ready;
    let request = IvySubmitRequest {
        version: 1,
        input_id: "00000000-0000-0000-0000-000000000001".into(),
        text: "never dispatched".into(),
    };
    host.request(Action::Submit(request)).unwrap();
    host.request(Action::Disconnect).unwrap();
    let submitted = receiver.try_recv().unwrap();
    let disconnected = receiver.try_recv().unwrap();
    assert!(!host.shared.current(submitted.epoch));
    let directory =
        std::env::temp_dir().join(format!("stellar-ivy-unadmitted-{}", std::process::id()));
    let (journal, record) = Journal::open(&directory).unwrap();
    let session = Session {
        journal,
        record,
        broker: None,
        shared: host.shared.clone(),
        epoch: disconnected.epoch,
        workspace_epoch: disconnected.workspace_epoch,
        buffered: vec![],
        replay: None,
    };
    session.restore_admission_state();
    assert_eq!(host.snapshot().unwrap().turn, IvyTurnState::Idle);
    assert_eq!(host.snapshot().unwrap().turn_id, None);
    assert!(!session.record.unsettled);
    host.shared.view.lock().unwrap().snapshot.connection = IvyConnectionState::Ready;
    host.request(Action::Submit(IvySubmitRequest {
        version: 1,
        input_id: "00000000-0000-0000-0000-000000000002".into(),
        text: "new explicit turn".into(),
    }))
    .unwrap();
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn ready_subscriber_submission_keeps_its_busy_and_deduplication_state() {
    let slot = Arc::new(Mutex::new(None::<std::sync::Weak<IvyHost>>));
    let observed = slot.clone();
    let fired = std::sync::atomic::AtomicBool::new(false);
    let (mut host, receiver) = fixture();
    host.shared.publish = Arc::new(move |snapshot| {
        if snapshot.connection == IvyConnectionState::Ready
            && snapshot.turn == IvyTurnState::Idle
            && !fired.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let host = observed
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .unwrap();
            host.request(Action::Submit(IvySubmitRequest {
                version: 1,
                input_id: "00000000-0000-0000-0000-000000000001".into(),
                text: "subscriber user turn".into(),
            }))
            .unwrap();
        }
    });
    let host = Arc::new(host);
    *slot.lock().unwrap() = Some(Arc::downgrade(&host));
    host.shared.view.lock().unwrap().snapshot.connection = IvyConnectionState::Connecting;
    let directory = std::env::temp_dir().join(format!("stellar-ivy-ready-{}", std::process::id()));
    let (journal, record) = Journal::open(&directory).unwrap();
    let session = Session {
        journal,
        record,
        broker: None,
        shared: host.shared.clone(),
        epoch: 0,
        workspace_epoch: 0,
        buffered: vec![],
        replay: None,
    };
    publish_ready(&session);
    assert_eq!(host.snapshot().unwrap().turn, IvyTurnState::Submitting);
    assert_eq!(
        host.snapshot().unwrap().turn_id.as_deref(),
        Some("00000000-0000-0000-0000-000000000001")
    );
    assert!(matches!(
        host.request(Action::Submit(IvySubmitRequest {
            version: 1,
            input_id: "00000000-0000-0000-0000-000000000002".into(),
            text: "second turn".into()
        })),
        Err(IvyErrorCode::Busy)
    ));
    assert!(matches!(
        receiver.try_recv().unwrap().action,
        Action::Submit(_)
    ));
    assert!(receiver.try_recv().is_err());
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
