use crate::{Action, GrantView, Presentation, UiError, UiRequest};
use std::{marker::PhantomData, rc::Rc, sync::Arc};

/// Local resource correlation only, never attachment or verification authority.
#[derive(Clone)]
pub struct WindowStamp {
    identity: Arc<()>,
    generation: u64,
}

/// No construction, cloning or wire conversion. This observes resource closure,
/// not authorized retirement, canonical cancellation or consent.
/// ```compile_fail
/// use stellar_consent_ui::ClosedObservation;
/// let _ = ClosedObservation {};
/// ```
/// ```compile_fail
/// use stellar_consent_ui::ClosedObservation;
/// fn duplicate(observed: ClosedObservation) { let _ = observed.clone(); }
/// ```
pub struct ClosedObservation {
    stamp: WindowStamp,
    thread: PhantomData<Rc<()>>,
}

impl ClosedObservation {
    pub fn consume_for(self, expected: &WindowStamp) -> Result<(), UiError> {
        if self.stamp.same(expected) {
            Ok(())
        } else {
            Err(UiError::MismatchedWindow)
        }
    }
}

impl WindowStamp {
    fn same(&self, other: &Self) -> bool {
        self.generation == other.generation && Arc::ptr_eq(&self.identity, &other.identity)
    }
}

/// Lifetime-bound placeholder; no handle accessor or native capability exists.
/// ```compile_fail
/// use stellar_consent_ui::NativeParent;
/// fn wrong_thread(parent: NativeParent<'static>) {
///     std::thread::spawn(move || drop(parent));
/// }
/// ```
/// ```compile_fail
/// use stellar_consent_ui::NativeParent;
/// fn needs_sync<T: Sync>() {}
/// needs_sync::<NativeParent<'static>>();
/// ```
pub struct NativeParent<'a> {
    owner: PhantomData<&'a OwnedScopeWindow>,
}

pub enum WindowUpdate {
    Requested(UiRequest),
    Destroyed,
}

/// Thread-affine UI resource. Production cannot construct its uninhabited Surface.
/// ```compile_fail
/// use stellar_consent_ui::OwnedScopeWindow;
/// let _ = OwnedScopeWindow {};
/// ```
/// ```compile_fail
/// use stellar_consent_ui::OwnedScopeWindow;
/// fn wrong_thread(window: OwnedScopeWindow) { std::thread::spawn(move || drop(window)); }
/// ```
/// ```compile_fail
/// use stellar_consent_ui::{NativeParent, OwnedScopeWindow};
/// fn escape(window: &OwnedScopeWindow) -> NativeParent<'static> {
///     window.borrow_native_parent().unwrap()
/// }
/// ```
pub struct OwnedScopeWindow {
    presentation: Presentation,
    stamp: WindowStamp,
    surface: Surface,
    invalidated: bool,
    close_attempted: bool,
    destroyed: bool,
    observation_taken: bool,
    thread: PhantomData<Rc<()>>,
}

struct NativeEvent {
    stamp: WindowStamp,
    action: Action,
}

// No production variant: no boolean, caller HWND or public backend can supply
// an owned native surface while the real Windows adapter is unavailable.
enum Surface {
    #[cfg(test)]
    Fixture(tests::FixtureSurface),
}

impl Surface {
    fn request_close(&mut self) -> Result<(), UiError> {
        match *self {
            #[cfg(test)]
            Self::Fixture(ref mut surface) => surface.request_close(),
        }
    }
    fn next_event(&mut self) -> Option<NativeEvent> {
        match *self {
            #[cfg(test)]
            Self::Fixture(ref mut surface) => surface.events.pop_front(),
        }
    }
}

impl OwnedScopeWindow {
    pub fn stamp(&self) -> WindowStamp {
        self.stamp.clone()
    }
    pub fn view(&self) -> &GrantView {
        self.presentation.view()
    }

    pub fn borrow_native_parent(&self) -> Result<NativeParent<'_>, UiError> {
        Err(UiError::Unavailable)
    }

    /// Dispatch acceptance only; no timeout or successful request proves closure.
    pub fn request_close(&mut self) -> Result<(), UiError> {
        if self.destroyed {
            return Ok(());
        }
        if self.close_attempted {
            return Err(UiError::ClosePending);
        }
        self.close_attempted = true;
        self.invalidated = true;
        self.surface.request_close()
    }

    pub fn next_event(&mut self) -> Result<Option<WindowUpdate>, UiError> {
        let Some(event) = self.surface.next_event() else {
            return Ok(None);
        };
        if !self.stamp.same(&event.stamp) {
            self.invalidated = true;
            let _ = self.request_close();
            return Err(UiError::MismatchedWindow);
        }
        if self.destroyed {
            return Err(UiError::Closed);
        }
        if event.action == Action::Destroyed {
            self.destroyed = true;
            self.invalidated = true;
            return Ok(Some(WindowUpdate::Destroyed));
        }
        if self.invalidated {
            return Err(UiError::Closed);
        }
        if event.action == Action::Cancel {
            self.invalidated = true;
        }
        self.presentation
            .request(event.action)
            .map(|request| Some(WindowUpdate::Requested(request)))
    }

    pub fn take_closed(&mut self) -> Result<ClosedObservation, UiError> {
        if !self.destroyed {
            return Err(UiError::ClosePending);
        }
        if self.observation_taken {
            return Err(UiError::Closed);
        }
        self.observation_taken = true;
        Ok(ClosedObservation {
            stamp: self.stamp.clone(),
            thread: PhantomData,
        })
    }
}

impl Drop for OwnedScopeWindow {
    fn drop(&mut self) {
        if !self.destroyed && !self.close_attempted {
            let _ = self.request_close();
        }
    }
}

#[cfg(test)]
#[path = "window_tests.rs"]
mod tests;
