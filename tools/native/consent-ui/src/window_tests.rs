use super::*;
use std::{cell::Cell, collections::VecDeque};

pub(super) struct FixtureSurface {
    pub(super) events: VecDeque<NativeEvent>,
    close_requests: Rc<Cell<usize>>,
    drops: Rc<Cell<usize>>,
    fail_close: bool,
}

impl FixtureSurface {
    pub(super) fn request_close(&mut self) -> Result<(), UiError> {
        self.close_requests.set(self.close_requests.get() + 1);
        if self.fail_close {
            Err(UiError::Unavailable)
        } else {
            Ok(())
        }
    }
}
impl Drop for FixtureSurface {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1);
    }
}

fn fixture(fail_close: bool) -> (OwnedScopeWindow, Rc<Cell<usize>>, Rc<Cell<usize>>) {
    let close_requests = Rc::new(Cell::new(0));
    let drops = Rc::new(Cell::new(0));
    let window = OwnedScopeWindow {
        presentation: Presentation::new(
            GrantView::new(["Ivy", "Original", "Worker"], 1000, 2).unwrap(),
        ),
        stamp: WindowStamp {
            identity: Arc::new(()),
            generation: 1,
        },
        surface: Surface::Fixture(FixtureSurface {
            events: VecDeque::new(),
            close_requests: close_requests.clone(),
            drops: drops.clone(),
            fail_close,
        }),
        invalidated: false,
        close_attempted: false,
        destroyed: false,
        observation_taken: false,
        thread: PhantomData,
    };
    (window, close_requests, drops)
}

fn event(window: &mut OwnedScopeWindow, stamp: WindowStamp, action: Action) {
    let Surface::Fixture(surface) = &mut window.surface;
    surface.events.push_back(NativeEvent { stamp, action });
}
fn own_event(window: &mut OwnedScopeWindow, action: Action) {
    event(window, window.stamp(), action);
}

#[test]
fn close_request_is_not_observed_closure_and_observation_is_one_use() {
    let (mut window, requests, drops) = fixture(false);
    let stamp = window.stamp();
    assert_eq!(window.view().max_admissions(), 2);
    assert!(matches!(
        window.borrow_native_parent(),
        Err(UiError::Unavailable)
    ));
    assert_eq!(window.request_close(), Ok(()));
    assert_eq!(window.request_close(), Err(UiError::ClosePending));
    assert!(matches!(window.take_closed(), Err(UiError::ClosePending)));
    assert!(matches!(window.next_event(), Ok(None)));
    own_event(&mut window, Action::Destroyed);
    assert!(matches!(
        window.next_event(),
        Ok(Some(WindowUpdate::Destroyed))
    ));
    assert_eq!(window.take_closed().unwrap().consume_for(&stamp), Ok(()));
    assert!(matches!(window.take_closed(), Err(UiError::Closed)));
    drop(window);
    assert_eq!((requests.get(), drops.get()), (1, 1));
}

#[test]
fn unexpected_and_requested_destruction_are_observations_not_automatic_cancel() {
    for requested in [false, true] {
        let (mut window, _, _) = fixture(false);
        own_event(&mut window, Action::Affirm);
        assert!(matches!(
            window.next_event(),
            Ok(Some(WindowUpdate::Requested(UiRequest::Complete)))
        ));
        if requested {
            window.request_close().unwrap();
        }
        own_event(&mut window, Action::Destroyed);
        assert!(matches!(
            window.next_event(),
            Ok(Some(WindowUpdate::Destroyed))
        ));
        own_event(&mut window, Action::Affirm);
        assert!(matches!(window.next_event(), Err(UiError::Closed)));
        // Guardian's private WindowFlow, not this resource adapter, decides
        // whether destruction was authorized retirement or premature loss.
        assert!(window.take_closed().is_ok());
    }
}

#[test]
fn cancel_is_explicit_and_late_affirmation_cannot_restore_eligibility() {
    let (mut window, _, _) = fixture(false);
    own_event(&mut window, Action::Cancel);
    assert!(matches!(
        window.next_event(),
        Ok(Some(WindowUpdate::Requested(UiRequest::Cancel)))
    ));
    own_event(&mut window, Action::Affirm);
    assert!(matches!(window.next_event(), Err(UiError::Closed)));
    assert!(matches!(window.take_closed(), Err(UiError::ClosePending)));
}

#[test]
fn foreign_identity_or_generation_never_certifies_own_closure() {
    for wrong_generation in [false, true] {
        let (mut window, requests, _) = fixture(false);
        let mut wrong = window.stamp();
        if wrong_generation {
            wrong.generation += 1;
        } else {
            wrong.identity = Arc::new(());
        }
        event(&mut window, wrong, Action::Destroyed);
        assert!(matches!(
            window.next_event(),
            Err(UiError::MismatchedWindow)
        ));
        assert_eq!(requests.get(), 1);
        assert!(matches!(window.take_closed(), Err(UiError::ClosePending)));
        own_event(&mut window, Action::Destroyed);
        assert!(matches!(
            window.next_event(),
            Ok(Some(WindowUpdate::Destroyed))
        ));
    }
}

#[test]
fn closed_fact_cannot_be_consumed_for_another_resource_or_generation() {
    for wrong_generation in [false, true] {
        let (mut window, _, _) = fixture(false);
        let mut wrong = window.stamp();
        if wrong_generation {
            wrong.generation += 1;
        } else {
            wrong.identity = Arc::new(());
        }
        own_event(&mut window, Action::Destroyed);
        window.next_event().unwrap();
        assert_eq!(
            window.take_closed().unwrap().consume_for(&wrong),
            Err(UiError::MismatchedWindow)
        );
        assert!(matches!(window.take_closed(), Err(UiError::Closed)));
    }
}

#[test]
fn failed_close_drop_and_duplicate_callbacks_never_create_an_ack() {
    let (mut window, requests, drops) = fixture(true);
    assert_eq!(window.request_close(), Err(UiError::Unavailable));
    assert!(matches!(window.take_closed(), Err(UiError::ClosePending)));
    drop(window);
    assert_eq!((requests.get(), drops.get()), (1, 1));
    let (window, requests, drops) = fixture(false);
    drop(window);
    assert_eq!((requests.get(), drops.get()), (1, 1));
    let (mut window, requests, _) = fixture(false);
    own_event(&mut window, Action::Destroyed);
    own_event(&mut window, Action::Destroyed);
    window.next_event().unwrap();
    assert!(matches!(window.next_event(), Err(UiError::Closed)));
    drop(window);
    assert_eq!(requests.get(), 0);
}
