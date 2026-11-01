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
