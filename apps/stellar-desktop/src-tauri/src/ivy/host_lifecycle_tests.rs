use super::tests::fixture;
use super::*;

#[test]
fn lifecycle_controls_share_the_admission_gate_and_preserve_busy_turns() {
    use super::super::lifecycle::Control;
    let (host, receiver) = fixture();
    host.shared
        .update(0, |view| view.connection = IvyConnectionState::Ready);
    let pending = host.lifecycle(Control::ReloadMcp).unwrap();
    assert!(matches!(
        host.lifecycle(Control::NewSession),
        Err(IvyErrorCode::Busy)
    ));
    assert!(matches!(
        host.rotate(IvyModel::Sol, false),
        Err(IvyErrorCode::Busy)
    ));
    assert!(matches!(
        host.request(Action::Submit(IvySubmitRequest {
            version: 1,
            input_id: "00000000-0000-4000-8000-000000000001".into(),
            text: "busy".into(),
        })),
        Err(IvyErrorCode::Busy)
    ));
    let work = receiver.try_recv().unwrap();
    if let Action::Lifecycle(_, ticket, reply) = work.action {
        rotation::finish(&host.pending_rotation, &ticket);
        reply.send(Ok(IvySnapshot::default())).unwrap();
    } else {
        panic!("wrong control")
    }
    pending.wait().unwrap();
    host.shared
        .update(0, |view| view.turn = IvyTurnState::Admitted);
    assert!(matches!(
        host.lifecycle(Control::ReloadMcp),
        Err(IvyErrorCode::Busy)
    ));
    assert!(receiver.try_recv().is_err());
}
