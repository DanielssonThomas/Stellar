#![forbid(unsafe_code)]
//! Literal presentation policy only. No window, verification, host-success or
//! attachment authority is constructed here. The guardian owns those boundaries.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiError {
    InvalidScope,
    Unavailable,
    Closed,
    ClosePending,
    MismatchedWindow,
}

mod window;
pub use window::{ClosedObservation, NativeParent, OwnedScopeWindow, WindowStamp, WindowUpdate};

#[derive(Debug, PartialEq, Eq)]
pub struct GrantView {
    labels: [String; 3],
    expires_at_ms: u64,
    max_admissions: u32,
}

impl GrantView {
    pub fn new(
        labels: [&str; 3],
        expires_at_ms: u64,
        max_admissions: u32,
    ) -> Result<Self, UiError> {
        if labels.iter().any(|label| {
            label.trim().is_empty()
                || label.len() > 256
                || label.chars().any(|c| {
                    c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
        }) || !(1..=9_007_199_254_740_991).contains(&expires_at_ms)
            || !(1..=100).contains(&max_admissions)
        {
            return Err(UiError::InvalidScope);
        }
        Ok(Self {
            labels: labels.map(str::to_owned),
            expires_at_ms,
            max_admissions,
        })
    }

    pub fn labels(&self) -> [&str; 3] {
        self.labels.each_ref().map(String::as_str)
    }
    pub fn effects(&self) -> [&'static str; 2] {
        ["render", "speech"]
    }
    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
    pub fn max_admissions(&self) -> u32 {
        self.max_admissions
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Affirm,
    Cancel,
    Destroyed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiRequest {
    Complete,
    Cancel,
}

/// Observational UI requests, never native consent or authorized window retirement.
pub struct Presentation {
    view: GrantView,
    affirmed: bool,
    closed: bool,
}

impl Presentation {
    pub fn new(view: GrantView) -> Self {
        Self {
            view,
            affirmed: false,
            closed: false,
        }
    }
    pub fn view(&self) -> &GrantView {
        &self.view
    }
    pub fn request(&mut self, action: Action) -> Result<UiRequest, UiError> {
        if self.closed {
            return Err(UiError::Closed);
        }
        match action {
            Action::Affirm if !self.affirmed => {
                self.affirmed = true;
                Ok(UiRequest::Complete)
            }
            Action::Affirm => Err(UiError::Closed),
            Action::Cancel | Action::Destroyed => {
                self.closed = true;
                Ok(UiRequest::Cancel)
            }
        }
    }
}

/// No Win32 surface is available until the separate native lifetime review.
pub fn present_native(_view: GrantView) -> Result<OwnedScopeWindow, UiError> {
    Err(UiError::Unavailable)
}

#[cfg(test)]
mod presentation_tests;
