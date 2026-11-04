use super::*;
use std::cell::{Cell, RefCell};

struct Mock {
    state: RefCell<ReflexMediaState>,
    calls: Cell<usize>,
    unavailable: Cell<bool>,
}
impl Mock {
    fn new() -> Self {
        Self {
            state: RefCell::new(ReflexMediaState {
                ticket: String::new(),
                player: Some("safe mock".into()),
                title: Some("track".into()),
                playing: true,
                volume: Some(50),
                muted: Some(false),
                endpoint_id: Some("device-1".into()),
                actions: vec!["next".into()],
            }),
            calls: Cell::new(0),
            unavailable: Cell::new(false),
        }
    }
}
impl MediaPort for Mock {
    fn snapshot(&self) -> Result<ReflexMediaState, ()> {
        if self.unavailable.get() {
            Err(())
        } else {
            Ok(self.state.borrow().clone())
        }
    }
    fn execute(
        &self,
        _: &ReflexMediaAction,
        _: &ReflexMediaState,
        commit: &Commit<'_>,
    ) -> ReflexMediaResult {
        if !commit(&mut || self.calls.set(self.calls.get() + 1)) {
            return ReflexMediaResult::Rejected;
        }

        ReflexMediaResult::Confirmed
    }
}
fn request(ticket: String) -> ReflexMediaRequest {
    ReflexMediaRequest {
        version: 1,
        input_id: "request-1".into(),
        ticket,
        action: ReflexMediaAction::Next,
    }
}

#[test]
fn executes_once_with_current_snapshot_and_rejects_replays() {
    let host = MediaHost::default();
    let port = Mock::new();
    let r = request(host.snapshot(&port).unwrap().ticket);
    assert!(matches!(
        host.execute(&r, &port),
        ReflexMediaResult::Confirmed
    ));
    assert!(matches!(
        host.execute(&r, &port),
        ReflexMediaResult::Rejected
    ));
    assert_eq!(port.calls.get(), 1);
}

#[test]
fn never_dispatches_a_changed_track_or_unavailable_device() {
    for unavailable in [false, true] {
        let host = MediaHost::default();
        let port = Mock::new();
        let r = request(host.snapshot(&port).unwrap().ticket);
        port.state.borrow_mut().title = Some("new track".into());
        port.unavailable.set(unavailable);
        assert!(matches!(
            host.execute(&r, &port),
            ReflexMediaResult::Rejected
        ));
        assert_eq!(port.calls.get(), 0);
    }
}

#[test]
fn concurrent_requests_fail_closed_without_hardware_access() {
    let host = MediaHost::default();
    let port = Mock::new();
    let r = request(host.snapshot(&port).unwrap().ticket);
    let _guard = host.0.lock().unwrap();
    assert!(matches!(
        host.execute(&r, &port),
        ReflexMediaResult::Rejected
    ));
    assert_eq!(port.calls.get(), 0);
}

#[test]
fn cancellation_and_changed_endpoint_invalidate_native_dispatch() {
    for cancel in [false, true] {
        let host = MediaHost::default();
        let port = Mock::new();
        let r = request(host.snapshot(&port).unwrap().ticket);
        if cancel {
            host.cancel(&r.input_id);
        } else {
            port.state.borrow_mut().endpoint_id = Some("new-device".into());
        }
        assert!(matches!(
            host.execute(&r, &port),
            ReflexMediaResult::Rejected
        ));
        assert_eq!(port.calls.get(), 0);
    }
}

#[test]
fn cancellation_while_rechecking_state_never_reaches_the_effect() {
    struct CancelDuringRead<'a> {
        host: &'a MediaHost,
        inner: Mock,
    }
    impl MediaPort for CancelDuringRead<'_> {
        fn snapshot(&self) -> Result<ReflexMediaState, ()> {
            self.host.cancel("request-1");
            self.inner.snapshot()
        }
        fn execute(
            &self,
            _: &ReflexMediaAction,
            _: &ReflexMediaState,
            _: &Commit<'_>,
        ) -> ReflexMediaResult {
            panic!("cancelled effect dispatched")
        }
    }
    let host = MediaHost::default();
    let port = Mock::new();
    let r = request(host.snapshot(&port).unwrap().ticket);
    assert!(matches!(
        host.execute(
            &r,
            &CancelDuringRead {
                host: &host,
                inner: port
            }
        ),
        ReflexMediaResult::Rejected
    ));
}
