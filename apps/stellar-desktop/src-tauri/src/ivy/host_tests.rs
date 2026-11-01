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
    (
        IvyHost {
            shared,
            child: Arc::new(Mutex::new(None)),
            sender,
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
