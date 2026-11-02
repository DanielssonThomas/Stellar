use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

#[test]
fn busy_owner_retries_only_on_connect_and_loads_the_retained_record() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "stellar-owner-retry-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let (first_owner, _) = Journal::open(&directory).unwrap();
    let original = Record {
        session_id: Some("retained-session".into()),
        input_id: Some("00000000-0000-0000-0000-000000000001".into()),
        admission_id: Some("retained-admission".into()),
        generation: Some(7),
        unsettled: true,
        model: IvyModel::Sol,
        route_verified: true,
        workspace: None,
    };
    first_owner.save(&original).unwrap();
    let initial = Journal::open(&directory);
    assert!(matches!(initial, Err(IvyErrorCode::Busy)));
    let (events, observed) = mpsc::channel();
    let state = Shared {
        view: Arc::new(Mutex::new(View {
            epoch: 1,
            snapshot: IvySnapshot {
                connection: IvyConnectionState::Unavailable,
                error: Some(IvyErrorCode::Busy),
                ..IvySnapshot::default()
            },
        })),
        publish: Arc::new(move |snapshot| {
            let _ = events.send(snapshot);
        }),
    };
    let (sender, receiver) = mpsc::sync_channel(4);
    let rotations: Pending = Arc::new(Mutex::new(None));
    let worker_state = state.clone();
    let worker_directory = directory.clone();
    let worker = std::thread::spawn(move || {
        acquire(
            initial,
            &worker_directory,
            &receiver,
            &worker_state,
            &rotations,
        )
    });
    sender
        .send(Work {
            epoch: 1,
            workspace_epoch: 0,
            action: Action::Reconcile,
        })
        .unwrap();
    let refused = observed.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(refused.error, Some(IvyErrorCode::Busy));
    sender
        .send(Work {
            epoch: 1,
            workspace_epoch: 0,
            action: Action::Connect,
        })
        .unwrap();
    let still_busy = observed.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(still_busy.error, Some(IvyErrorCode::Busy));
    assert_eq!(still_busy.connection, IvyConnectionState::Unavailable);
    drop(first_owner);
    sender
        .send(Work {
            epoch: 1,
            workspace_epoch: 0,
            action: Action::Connect,
        })
        .unwrap();
    let restored = observed.recv_timeout(Duration::from_secs(2)).unwrap();
    let (journal, record, first_work) = worker.join().unwrap().unwrap();
    assert!(matches!(first_work.unwrap().action, Action::Connect));
    assert_eq!(record.session_id, original.session_id);
    assert_eq!(record.admission_id, original.admission_id);
    assert_eq!(record.generation, original.generation);
    assert!(record.unsettled);
    assert_eq!(restored.turn_id, original.input_id);
    assert_eq!(restored.model, IvyModel::Sol);
    assert_eq!(restored.turn, IvyTurnState::Uncertain);
    assert_eq!(restored.verified_model, None);
    assert!(
        restored.revision.parse::<u64>().unwrap() > still_busy.revision.parse::<u64>().unwrap()
    );
    drop(journal);
    std::fs::remove_dir_all(directory).unwrap();
}
