use super::tests::fixture;
use super::*;

#[test]
fn confirmed_same_model_selection_keeps_workspace_epoch_and_skips_queue() {
    let (host, receiver) = fixture();
    for model in [IvyModel::Terra, IvyModel::Sol] {
        host.shared.update(0, |view| {
            view.connection = IvyConnectionState::Ready;
            view.model = model;
            view.verified_model = Some(model);
        });
        let before = host.snapshot().unwrap();
        let after = host.rotate(model, false).unwrap().wait().unwrap();
        assert_eq!(after.workspace_epoch, before.workspace_epoch);
        assert_eq!(after.revision, before.revision);
        assert!(receiver.try_recv().is_err());
    }
    host.shared.update(0, |view| view.verified_model = None);
    let _reply = host.rotate(IvyModel::Sol, false).unwrap();
    assert!(matches!(
        receiver.try_recv().unwrap().action,
        Action::Rotate(IvyModel::Sol, false, _, _)
    ));
}

#[test]
fn confirmed_route_never_skips_busy_or_forced_session_switches() {
    let (host, receiver) = fixture();
    host.shared.update(0, |view| {
        view.connection = IvyConnectionState::Ready;
        view.verified_model = Some(IvyModel::Terra);
        view.turn = IvyTurnState::Uncertain;
    });
    assert!(matches!(
        host.rotate(IvyModel::Terra, false),
        Err(IvyErrorCode::Busy)
    ));
    host.shared.update(0, |view| view.turn = IvyTurnState::Idle);
    let _reply = host.rotate(IvyModel::Terra, true).unwrap();
    assert!(matches!(
        receiver.try_recv().unwrap().action,
        Action::Rotate(IvyModel::Terra, true, _, _)
    ));
}
