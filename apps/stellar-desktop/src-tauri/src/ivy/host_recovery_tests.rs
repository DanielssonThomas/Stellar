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
fn ready_uncertain_connect_enqueues_reconciliation_without_replay() {
    let (host, receiver) = fixture();
    host.shared.update(0, |view| {
        view.connection = IvyConnectionState::Ready;
        view.turn = IvyTurnState::Uncertain;
        view.turn_id = Some("retained".into());
    });
    let before = host.snapshot().unwrap();
    let accepted = host.request(Action::Connect).unwrap();
    assert_eq!(accepted.turn, IvyTurnState::Uncertain);
    assert_eq!(accepted.turn_id, before.turn_id);
    assert_eq!(accepted.workspace_epoch, before.workspace_epoch);
    assert!(matches!(
        receiver.try_recv().unwrap().action,
        Action::Reconcile
    ));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn ready_settled_connect_remains_a_noop() {
    let (host, receiver) = fixture();
    host.shared
        .update(0, |view| view.connection = IvyConnectionState::Ready);
    host.request(Action::Connect).unwrap();
    assert!(receiver.try_recv().is_err());
}
