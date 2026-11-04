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
fn receipt_is_only_emitted_for_validated_dispatch_and_does_not_change_result() {
    let host = MediaHost::default();
    let port = Mock::new();
    let count = Cell::new(0);
    let r = request(host.snapshot(&port).unwrap().ticket);
    let result = host.execute_observed(&r, &port, |req, state, result| {
        count.set(count.get() + 1);
        assert_eq!(req.input_id, "request-1");
        assert_eq!(state.title.as_deref(), Some("track"));
        assert!(matches!(result, ReflexMediaResult::Confirmed));
    });
    assert!(matches!(result, ReflexMediaResult::Confirmed));
    assert_eq!(count.get(), 1);
    host.execute_observed(&r, &port, |_, _, _| count.set(count.get() + 1));
    assert_eq!(count.get(), 1);
    host.snapshot(&port).unwrap();
    assert_eq!(count.get(), 1);
}

#[test]
fn disable_revokes_tickets_and_enable_requires_a_fresh_snapshot() {
    let host = MediaHost::default();
    let port = Mock::new();
    let old = request(host.snapshot(&port).unwrap().ticket);
    host.set_enabled(false);
    assert!(host.snapshot(&port).is_err());
    assert!(matches!(
        host.execute(&old, &port),
        ReflexMediaResult::Rejected
    ));
    host.set_enabled(true);
    assert!(matches!(
        host.execute(&old, &port),
        ReflexMediaResult::Rejected
    ));
    let mut fresh = request(host.snapshot(&port).unwrap().ticket);
    fresh.input_id = "fresh-request".into();
    assert!(matches!(
        host.execute(&fresh, &port),
        ReflexMediaResult::Confirmed
    ));
    assert_eq!(port.calls.get(), 1);
}

#[test]
fn disable_at_commit_prevents_a_queued_device_effect() {
    struct DisableAtCommit<'a>(&'a MediaHost, Mock);
    impl MediaPort for DisableAtCommit<'_> {
        fn snapshot(&self) -> Result<ReflexMediaState, ()> {
            self.1.snapshot()
        }
        fn execute(
            &self,
            action: &ReflexMediaAction,
            expected: &ReflexMediaState,
            commit: &Commit<'_>,
        ) -> ReflexMediaResult {
            self.0.set_enabled(false);
            self.1.execute(action, expected, commit)
        }
    }
    let host = MediaHost::default();
    let port = DisableAtCommit(&host, Mock::new());
    let r = request(host.snapshot(&port).unwrap().ticket);
    assert!(matches!(
        host.execute(&r, &port),
        ReflexMediaResult::Rejected
    ));
    assert_eq!(port.1.calls.get(), 0);
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
