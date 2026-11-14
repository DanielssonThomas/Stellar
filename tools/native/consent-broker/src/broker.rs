use crate::capabilities::{Attachment, GrantIntent, Verification};
use crate::{Error, Prepared};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Confirming,
    Consumed,
    Cancelled,
    Expired,
    Uncertain,
}

struct Entry {
    token: Arc<()>,
    attachment: [u8; 32],
    policy: [u8; 32],
    generation: u64,
    scope: Prepared,
    digest: [u8; 32],
    deadline: Instant,
    state: State,
}

/// Bounded state only. No production constructor grants trust; no entry is evicted.
pub struct Broker {
    entries: Vec<Entry>,
}

pub(crate) fn now() -> Result<(u64, Instant), Error> {
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Uncertain)?;
    let millis = u64::try_from(wall.as_millis()).map_err(|_| Error::Uncertain)?;
    Ok((millis, Instant::now()))
}

pub(crate) fn digest(
    scope: &Prepared,
    policy: &[u8; 32],
    generation: u64,
) -> Result<[u8; 32], Error> {
    let mut hash = Sha256::new();
    hash.update(b"stellar.native-consent.v2\0");
    hash.update(crate::protocol::SEMANTICS);
    hash.update(policy);
    hash.update(generation.to_be_bytes());
    let mut bytes = vec![];
    crate::canonical::canonical(
        &serde_json::to_value(scope).map_err(|_| Error::InvalidRequest)?,
        &mut bytes,
    )?;
    hash.update(bytes);
    Ok(hash.finalize().into())
}

impl Broker {
    /// No OS custody, approved launch or genuine verifier adapter ships in this slice.
    pub fn unavailable() -> Result<Self, Error> {
        Err(Error::HostUnverified)
    }

    pub fn prepare(&mut self, attachment: &Attachment) -> Result<Prepared, Error> {
        let (wall, mono) = now()?;
        if !attachment.alive {
            return Err(Error::TransportChanged);
        }
        attachment.scope.validate()?;
        let scope = &attachment.scope;
        if scope.challenge_expires_at <= wall
            || scope.challenge_expires_at - wall > 60_000
            || scope.expires_at <= wall
            || scope.expires_at - wall > 604_800_000
        {
            return Err(Error::ChallengeExpired);
        }
        if self.entries.len() >= 64 {
            return Err(Error::Busy);
        }
        let mut pending = 0;
        for entry in &mut self.entries {
            entry.expire(wall, mono);
            if matches!(entry.state, State::Pending | State::Confirming) {
                pending += 1;
                if entry.attachment == attachment.identity {
                    return Err(Error::Busy);
                }
            }
            // Retained uncertainty/consumption cannot be bypassed by another challenge.
            if entry.attachment == attachment.identity {
                return Err(Error::Uncertain);
            }
            if entry.scope.challenge_id == scope.challenge_id
                || entry.scope.connection_binding == scope.connection_binding
            {
                return Err(Error::InvalidRequest);
            }
        }
        if pending >= 16 {
            return Err(Error::Busy);
        }
        self.entries.push(Entry {
            token: Arc::clone(&attachment.token),
            attachment: attachment.identity,
            policy: attachment.policy,
            generation: attachment.generation,
            scope: scope.clone(),
            digest: digest(scope, &attachment.policy, attachment.generation)?,
            deadline: mono + std::time::Duration::from_millis(scope.challenge_expires_at - wall),
            state: State::Pending,
        });
        Ok(scope.clone())
    }

    /// Reserves the single prompt. It does not create positive verification evidence.
    pub fn begin(&mut self, attachment: &Attachment, challenge: &str) -> Result<(), Error> {
        let entry = self.current(attachment, challenge)?;
        entry.require(State::Pending)?;
        entry.state = State::Confirming;
        Ok(())
    }

    pub fn cancel(&mut self, attachment: &Attachment, challenge: &str) -> Result<(), Error> {
        let entry = self.current(attachment, challenge)?;
        if !matches!(entry.state, State::Pending | State::Confirming) {
            return entry.require(State::Pending);
        }
        entry.state = State::Cancelled;
        Ok(())
    }

    /// The future private verifier creates evidence only for its owned window/callback.
    pub fn verified(
        &mut self,
        attachment: &Attachment,
        challenge: &str,
        verification: Verification,
    ) -> Result<GrantIntent, Error> {
        let entry = self.current(attachment, challenge)?;
        entry.require(State::Confirming)?;
        if verification.attachment != entry.attachment
            || verification.generation != entry.generation
            || verification.digest != entry.digest
            || !Arc::ptr_eq(&verification.token, &entry.token)
        {
            entry.state = State::Uncertain;
            return Err(Error::Uncertain);
        }
        entry.state = State::Consumed;
        Ok(GrantIntent {
            token: Arc::clone(&entry.token),
            attachment: entry.attachment,
            generation: entry.generation,
            digest: entry.digest,
            challenge: challenge.to_owned(),
        })
    }

    /// Reserve BEFORE a future host effect; even failure cannot reissue this intent.
    /// This passive implementation cannot call Host.approve or mint a ticket.
    pub fn reserve_intent(
        &mut self,
        attachment: &Attachment,
        intent: GrantIntent,
    ) -> Result<(), Error> {
        let entry = self.current(attachment, &intent.challenge)?;
        entry.require(State::Consumed)?;
        entry.state = State::Uncertain;
        if intent.attachment != entry.attachment
            || intent.generation != entry.generation
            || intent.digest != entry.digest
            || !Arc::ptr_eq(&intent.token, &entry.token)
        {
            return Err(Error::Uncertain);
        }
        Ok(())
    }

    pub fn invalidate(&mut self, attachment: &mut Attachment) {
        attachment.alive = false;
        for entry in &mut self.entries {
            if entry.attachment == attachment.identity
                && matches!(entry.state, State::Pending | State::Confirming)
            {
                entry.state = State::Cancelled;
            }
        }
    }

    fn current(&mut self, attachment: &Attachment, challenge: &str) -> Result<&mut Entry, Error> {
        let (wall, mono) = now()?;
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.scope.challenge_id == challenge)
            .ok_or(Error::ChallengeUnknown)?;
        entry.expire(wall, mono);
        if !attachment.alive
            || entry.attachment != attachment.identity
            || entry.generation != attachment.generation
            || !Arc::ptr_eq(&attachment.token, &entry.token)
        {
            return Err(Error::TransportChanged);
        }
        if entry.policy != attachment.policy {
            entry.state = State::Cancelled;
            return Err(Error::PolicyChanged);
        }
        if entry.scope != attachment.scope {
            entry.state = State::Cancelled;
            return Err(Error::OriginChanged);
        }
        Ok(entry)
    }
}

impl Entry {
    fn expire(&mut self, wall: u64, mono: Instant) {
        if matches!(
            self.state,
            State::Pending | State::Confirming | State::Consumed
        ) && (wall >= self.scope.challenge_expires_at || mono >= self.deadline)
        {
            self.state = State::Expired;
        }
    }

    fn require(&self, required: State) -> Result<(), Error> {
        if self.state == required {
            return Ok(());
        }
        Err(match self.state {
            State::Pending => Error::ApprovalRequired,
            State::Confirming => Error::Busy,
            State::Consumed => Error::ChallengeConsumed,
            State::Cancelled => Error::ChallengeCancelled,
            State::Expired => Error::ChallengeExpired,
            State::Uncertain => Error::Uncertain,
        })
    }
}

#[cfg(test)]
#[path = "broker_tests.rs"]
mod tests;
