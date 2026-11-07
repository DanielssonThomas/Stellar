use super::contracts::{MicrophoneReviewError, MicrophoneReviewOutcome, MicrophoneReviewRequest};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub const OWNED_ORIGIN: &str = "http://tauri.localhost";

pub fn owned_origin(url: &tauri::Url) -> bool {
    url.origin().ascii_serialization() == OWNED_ORIGIN
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn validate(
    label: &str,
    url: &tauri::Url,
    value: Option<serde_json::Value>,
) -> Result<(), MicrophoneReviewError> {
    let request: MicrophoneReviewRequest =
        serde_json::from_value(value.ok_or(MicrophoneReviewError::Malformed)?)
            .map_err(|_| MicrophoneReviewError::Malformed)?;
    if request.version != 1 {
        return Err(MicrophoneReviewError::UnsupportedVersion);
    }
    if label != "main" || !owned_origin(url) {
        return Err(MicrophoneReviewError::Forbidden);
    }
    Ok(())
}

#[derive(Default)]
pub struct ReviewHost {
    busy: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}

impl ReviewHost {
    pub fn begin(&self) -> Result<ReviewLease, MicrophoneReviewError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(MicrophoneReviewError::Unavailable);
        }
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(MicrophoneReviewError::Busy);
        }
        Ok(ReviewLease {
            activity: Arc::new(ReviewActivity {
                busy: self.busy.clone(),
            }),
            closed: self.closed.clone(),
            valid: Arc::new(AtomicBool::new(true)),
        })
    }
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
    }
}

struct ReviewActivity {
    busy: Arc<AtomicBool>,
}
impl Drop for ReviewActivity {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

pub struct ReviewLease {
    activity: Arc<ReviewActivity>,
    closed: Arc<AtomicBool>,
    valid: Arc<AtomicBool>,
}

impl ReviewLease {
    pub fn token(&self) -> ReviewToken {
        ReviewToken {
            _activity: self.activity.clone(),
            closed: self.closed.clone(),
            valid: self.valid.clone(),
        }
    }
}
impl Drop for ReviewLease {
    fn drop(&mut self) {
        self.valid.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
pub struct ReviewToken {
    _activity: Arc<ReviewActivity>,
    closed: Arc<AtomicBool>,
    valid: Arc<AtomicBool>,
}
impl ReviewToken {
    pub fn current(&self) -> bool {
        !self.closed.load(Ordering::Acquire) && self.valid.load(Ordering::Acquire)
    }
}

#[cfg(any(windows, test))]
pub fn consent(
    supported: bool,
    current: impl Fn() -> bool,
    confirm: impl FnOnce() -> Result<bool, MicrophoneReviewError>,
) -> Result<MicrophoneReviewOutcome, MicrophoneReviewError> {
    if !supported {
        return Err(MicrophoneReviewError::Unsupported);
    }
    if !current() {
        return Ok(MicrophoneReviewOutcome::Cancelled);
    }
    let allowed = confirm()?;
    Ok(if allowed && current() {
        MicrophoneReviewOutcome::Allowed
    } else {
        MicrophoneReviewOutcome::Cancelled
    })
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
