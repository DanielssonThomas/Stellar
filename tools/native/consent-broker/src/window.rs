use crate::broker::{digest, now};
use crate::capabilities::{Attachment, GrantIntent, HostConsumeSuccess};
use crate::{Error, Prepared};
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, Instant};

/// Observational model state, never a native verification or cleanup receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowPhase {
    Pending,
    Confirming,
    CallbackConsumed,
    HostUncertain,
    RetirementAuthorized,
    Closed,
    Denied(Error),
}

struct Snapshot {
    token: Arc<()>,
    identity: [u8; 32],
    generation: u64,
    policy: [u8; 32],
    scope: Prepared,
    digest: [u8; 32],
}

impl Snapshot {
    fn check(&self, attachment: &Attachment) -> Result<(), Error> {
        if !attachment.alive
            || !Arc::ptr_eq(&self.token, &attachment.token)
            || self.identity != attachment.identity
            || self.generation != attachment.generation
        {
            return Err(Error::TransportChanged);
        }
        if self.policy != attachment.policy {
            return Err(Error::PolicyChanged);
        }
        if self.scope != attachment.scope {
            return Err(Error::OriginChanged);
        }
        Ok(())
    }
}

/// Pure lifecycle only: no HWND, native callback factory, I/O or host invocation.
/// Claim requires an existing private Attachment and is one-use for its lifetime.
pub struct WindowFlow {
    snapshot: Snapshot,
    window_generation: u64,
    phase: WindowPhase,
    host_effect_reserved: bool,
    deadline: Instant,
}

impl WindowFlow {
    pub fn claim(attachment: &Attachment, window_generation: u64) -> Result<Self, Error> {
        if !attachment.alive {
            return Err(Error::TransportChanged);
        }
        if window_generation == 0 {
            return Err(Error::InvalidRequest);
        }
        attachment.scope.validate()?;
        let (wall, mono) = now()?;
        if attachment.scope.challenge_expires_at <= wall
            || attachment.scope.challenge_expires_at - wall > 60_000
            || attachment.scope.expires_at - wall > 604_800_000
        {
            return Err(Error::ChallengeExpired);
        }
        let hash = digest(&attachment.scope, &attachment.policy, attachment.generation)?;
        if attachment
            .flow_claimed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Error::Uncertain);
        }
        Ok(Self {
            snapshot: Snapshot {
                token: Arc::clone(&attachment.token),
                identity: attachment.identity,
                generation: attachment.generation,
                policy: attachment.policy,
                scope: attachment.scope.clone(),
                digest: hash,
            },
            window_generation,
            phase: WindowPhase::Pending,
            host_effect_reserved: false,
            deadline: mono + Duration::from_millis(attachment.scope.challenge_expires_at - wall),
        })
    }

    fn current(&mut self, attachment: &Attachment, window_generation: u64) -> Result<(), Error> {
        if let WindowPhase::Denied(error) = self.phase {
            return Err(error);
        }
        if self.phase != WindowPhase::Closed {
            let (wall, mono) = now()?;
            if wall >= self.snapshot.scope.challenge_expires_at || mono >= self.deadline {
                self.phase = WindowPhase::Denied(Error::ChallengeExpired);
                return Err(Error::ChallengeExpired);
            }
        }
        let checked = self.snapshot.check(attachment).and({
            if self.window_generation == window_generation {
                Ok(())
            } else {
                Err(Error::ChallengeCancelled)
            }
        });
        if let Err(error) = checked {
            self.phase = WindowPhase::Denied(error);
        }
        checked
    }

    fn require(&self, expected: WindowPhase) -> Result<(), Error> {
        if self.phase == expected {
            return Ok(());
        }
        Err(match self.phase {
            WindowPhase::Pending => Error::ApprovalRequired,
            WindowPhase::Confirming => Error::Busy,
            WindowPhase::CallbackConsumed
            | WindowPhase::RetirementAuthorized
            | WindowPhase::Closed => Error::ChallengeConsumed,
            WindowPhase::HostUncertain => Error::Uncertain,
            WindowPhase::Denied(error) => error,
        })
    }

    pub fn begin(&mut self, attachment: &Attachment, window_generation: u64) -> Result<(), Error> {
        self.current(attachment, window_generation)?;
        self.require(WindowPhase::Pending)?;
        self.phase = WindowPhase::Confirming;
        Ok(())
    }

    pub fn callback_consumed(
        &mut self,
        attachment: &Attachment,
        window_generation: u64,
        intent: &GrantIntent,
    ) -> Result<(), Error> {
        self.current(attachment, window_generation)?;
        self.require(WindowPhase::Confirming)?;
        if !Arc::ptr_eq(&self.snapshot.token, &intent.token)
            || intent.attachment != self.snapshot.identity
            || intent.generation != self.snapshot.generation
            || intent.digest != self.snapshot.digest
            || intent.challenge != self.snapshot.scope.challenge_id
        {
            self.phase = WindowPhase::Denied(Error::Uncertain);
            return Err(Error::Uncertain);
        }
        self.phase = WindowPhase::CallbackConsumed;
        Ok(())
    }

    /// Must precede any future external host effect. No reset/retry transition.
    pub fn reserve_host_effect(
        &mut self,
        attachment: &Attachment,
        window_generation: u64,
    ) -> Result<(), Error> {
        self.current(attachment, window_generation)?;
        self.require(WindowPhase::CallbackConsumed)?;
        self.host_effect_reserved = true;
        self.phase = WindowPhase::HostUncertain;
        Ok(())
    }

    /// Host success-shaped DTOs cannot be passed here: only private evidence may
    /// authorize deliberate window retirement after the original consume reply.
    pub fn host_succeeded(
        &mut self,
        attachment: &Attachment,
        window_generation: u64,
        success: HostConsumeSuccess,
    ) -> Result<(), Error> {
        self.current(attachment, window_generation)?;
        self.require(WindowPhase::HostUncertain)?;
        if !Arc::ptr_eq(&self.snapshot.token, &success.token)
            || success.attachment != self.snapshot.identity
            || success.generation != self.snapshot.generation
            || success.digest != self.snapshot.digest
            || success.challenge != self.snapshot.scope.challenge_id
        {
            self.phase = WindowPhase::Denied(Error::Uncertain);
            return Err(Error::Uncertain);
        }
        self.phase = WindowPhase::RetirementAuthorized;
        Ok(())
    }

    /// Models an observed close; it does not establish OS/window cleanup proof.
    pub fn window_destroyed(
        &mut self,
        attachment: &Attachment,
        window_generation: u64,
    ) -> Result<(), Error> {
        self.current(attachment, window_generation)?;
        match self.phase {
            WindowPhase::RetirementAuthorized => {
                self.phase = WindowPhase::Closed;
                Ok(())
            }
            WindowPhase::Closed => Ok(()),
            _ => self.cancel(),
        }
    }

    /// Cancels local eligibility, not a canonical binding or physical effect.
    pub fn cancel(&mut self) -> Result<(), Error> {
        if let WindowPhase::Denied(error) = self.phase {
            return Err(error);
        }
        let error = if self.host_effect_reserved {
            Error::Uncertain
        } else {
            Error::ChallengeCancelled
        };
        self.phase = WindowPhase::Denied(error);
        Err(error)
    }

    pub fn invalidate_attachment(&mut self) {
        if !matches!(self.phase, WindowPhase::Denied(_)) {
            self.phase = WindowPhase::Denied(Error::TransportChanged);
        }
    }

    pub fn phase(&self) -> WindowPhase {
        self.phase
    }
    pub fn host_effect_reserved(&self) -> bool {
        self.host_effect_reserved
    }
}

#[cfg(test)]
#[path = "window_tests.rs"]
mod window_tests;
