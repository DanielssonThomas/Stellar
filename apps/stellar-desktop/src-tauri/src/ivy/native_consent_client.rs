//! INACTIVE: no app registration, authenticated connection or bind authority.
//! Compiled against the immutable producer crate by verify-inactive-consent.mjs.
use std::sync::Arc;
use stellar_consent_broker::{
    ChallengeRequest, ClientLane, ControlReply, Error as BrokerError, Origin, PacketReader,
    PrepareRequest, Prepared, Request, Response, Ticket,
};
use stellar_consent_ui::GrantView;

#[path = "native_consent_write.rs"]
mod write;
pub use write::{Outbound, WriteObservation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientError {
    Protocol,
    ScopeChanged,
    Expired,
    Uncertain,
    Spent,
    NotPrepared,
}

/// Clock observations are data from the future native owner, never wire authority.
#[derive(Clone, Copy)]
pub struct Clock {
    pub wall_ms: u64,
    pub monotonic_ms: u64,
}

pub enum Event {
    Prepared,
    Ticket(Ticket),
    CancelAcknowledged,
    Denied(BrokerError),
}

/// One slot per future original transport lifetime. A fresh unverified slot does
/// not authenticate a transport or resolve any durable previous uncertainty.
pub struct ClientSlot {
    spent: bool,
}

impl ClientSlot {
    pub fn new_unverified() -> Self {
        Self { spent: false }
    }
    pub fn open(&mut self, origin: Origin, now: Clock) -> Result<InactiveClient, ClientError> {
        if self.spent {
            return Err(ClientError::Spent);
        }
        self.spent = true;
        origin.validate().map_err(|_| ClientError::ScopeChanged)?;
        if origin.profile_id != "ivy" {
            return Err(ClientError::ScopeChanged);
        }
        Ok(InactiveClient {
            origin,
            last: now,
            lane: ClientLane::new(),
            packets: PacketReader::new(),
            attempts: vec![],
            prepared: None,
            monotonic_deadline: None,
            prepare_sent: false,
            complete_sent: false,
            cancel_sent: false,
            lineage: Arc::new(write::Dispatch::new()),
        })
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Prepare,
    Complete,
    Cancel,
}
struct Attempt {
    sequence: u64,
    kind: Kind,
    write_observed: bool,
    deferred: Option<ControlReply>,
}

pub struct InactiveClient {
    origin: Origin,
    last: Clock,
    lane: ClientLane,
    packets: PacketReader,
    // Retained independently: producer receive removes static correlation before
    // our contextual scope/deadline checks. Never erase attempted identities.
    attempts: Vec<Attempt>,
    prepared: Option<Prepared>,
    monotonic_deadline: Option<u64>,
    prepare_sent: bool,
    complete_sent: bool,
    cancel_sent: bool,
    lineage: Arc<write::Dispatch>,
}

impl Drop for InactiveClient {
    fn drop(&mut self) {
        self.lineage.seal();
    }
}

impl InactiveClient {
    fn fail<T>(&mut self, error: ClientError) -> Result<T, ClientError> {
        self.lane.close();
        self.lineage.seal();
        Err(error)
    }

    fn context(&mut self, current: &Origin, now: Clock) -> Result<(), ClientError> {
        if self.is_sealed() {
            return self.fail(ClientError::Uncertain);
        }
        if current != &self.origin {
            return self.fail(ClientError::ScopeChanged);
        }
        if now.wall_ms < self.last.wall_ms || now.monotonic_ms < self.last.monotonic_ms {
            return self.fail(ClientError::Uncertain);
        }
        self.last = now;
        Ok(())
    }

    fn eligible(&mut self, now: Clock) -> Result<(), ClientError> {
        let Some(prepared) = &self.prepared else {
            return Err(ClientError::NotPrepared);
        };
        if now.wall_ms >= prepared.challenge_expires_at
            || self
                .monotonic_deadline
                .is_none_or(|deadline| now.monotonic_ms >= deadline)
        {
            return self.fail(ClientError::Expired);
        }
        Ok(())
    }

    fn reserve(&mut self, request: Request, kind: Kind) -> Result<Outbound, ClientError> {
        let (sequence, bytes) = self
            .lane
            .reserve(request)
            .map_err(|_| ClientError::Uncertain)?;
        self.attempts.push(Attempt {
            sequence,
            kind,
            write_observed: false,
            deferred: None,
        });
        Ok(Outbound {
            sequence,
            bytes,
            lineage: self.lineage.clone(),
        })
    }

    pub fn prepare(&mut self, current: &Origin, now: Clock) -> Result<Outbound, ClientError> {
        self.context(current, now)?;
        if self.prepare_sent {
            return Err(ClientError::Spent);
        }
        self.prepare_sent = true;
        let Some(deadline) = now.monotonic_ms.checked_add(60_000) else {
            return self.fail(ClientError::Uncertain);
        };
        self.monotonic_deadline = Some(deadline);
        self.reserve(
            Request::Prepare(PrepareRequest {
                session_id: self.origin.session_id.clone(),
            }),
            Kind::Prepare,
        )
    }

    pub fn complete(&mut self, current: &Origin, now: Clock) -> Result<Outbound, ClientError> {
        self.context(current, now)?;
        self.eligible(now)?;
        if self.complete_sent || self.cancel_sent {
            return Err(ClientError::Spent);
        }
        self.complete_sent = true;
        self.reserve(Request::Complete(self.challenge()?), Kind::Complete)
    }

    pub fn cancel(&mut self, current: &Origin, now: Clock) -> Result<Outbound, ClientError> {
        self.context(current, now)?;
        if self.cancel_sent {
            return Err(ClientError::Spent);
        }
        let request = self.challenge()?;
        self.cancel_sent = true;
        self.reserve(Request::Cancel(request), Kind::Cancel)
    }

    fn challenge(&self) -> Result<ChallengeRequest, ClientError> {
        Ok(ChallengeRequest {
            challenge_id: self
                .prepared
                .as_ref()
                .ok_or(ClientError::NotPrepared)?
                .challenge_id
                .clone(),
        })
    }

    pub fn wrote(
        &mut self,
        result: WriteObservation,
        current: &Origin,
        now: Clock,
    ) -> Result<Vec<Event>, ClientError> {
        self.context(current, now)?;
        if !Arc::ptr_eq(&result.lineage, &self.lineage) {
            return self.fail(ClientError::Protocol);
        }
        let Some(attempt) = self
            .attempts
            .iter_mut()
            .find(|a| a.sequence == result.sequence)
        else {
            return self.fail(ClientError::Protocol);
        };
        if attempt.write_observed || !result.full_write {
            return self.fail(ClientError::Uncertain);
        }
        attempt.write_observed = true;
        let deferred = attempt.deferred.take();
        match deferred {
            Some(reply) => self.event(reply, now).map(|event| vec![event]),
            None => Ok(vec![]),
        }
    }

    pub fn receive(
        &mut self,
        input: &[u8],
        current: &Origin,
        now: Clock,
    ) -> Result<Vec<Event>, ClientError> {
        self.context(current, now)?;
        let mut offset = 0;
        let mut events = vec![];
        while offset < input.len() {
            let (used, payload) = match self.packets.ingest(&input[offset..]) {
                Ok(value) => value,
                Err(_) => return self.fail(ClientError::Protocol),
            };
            offset += used;
            if let Some(payload) = payload
                && let Some(event) = self.reply(&payload, now)?
            {
                events.push(event);
            }
        }
        Ok(events)
    }

    fn reply(&mut self, payload: &[u8], now: Clock) -> Result<Option<Event>, ClientError> {
        let reply = match self.lane.receive(payload) {
            Ok(reply) => reply,
            Err(_) => return self.fail(ClientError::Protocol),
        };
        let Some(attempt) = self
            .attempts
            .iter_mut()
            .find(|a| a.sequence == reply.sequence)
        else {
            return self.fail(ClientError::Protocol);
        };
        if !attempt.write_observed {
            attempt.deferred = Some(reply);
            return Ok(None);
        }
        self.event(reply, now).map(Some)
    }

    fn event(&mut self, reply: ControlReply, now: Clock) -> Result<Event, ClientError> {
        let kind = self
            .attempts
            .iter()
            .find(|a| a.sequence == reply.sequence)
            .map(|a| a.kind)
            .ok_or(ClientError::Protocol)?;
        match reply.outcome {
            Err(error) => Ok(Event::Denied(error)),
            Ok(Response::Prepared(value)) if matches!(kind, Kind::Prepare) => {
                if value.origin != self.origin {
                    return self.fail(ClientError::ScopeChanged);
                }
                if now.wall_ms >= value.challenge_expires_at {
                    return self.fail(ClientError::Expired);
                }
                let Some(request_deadline) = self.monotonic_deadline else {
                    return self.fail(ClientError::Uncertain);
                };
                if now.monotonic_ms >= request_deadline {
                    return self.fail(ClientError::Expired);
                }
                let challenge_ms = value.challenge_expires_at - now.wall_ms;
                if challenge_ms > 60_000 || value.expires_at - now.wall_ms > 604_800_000 {
                    return self.fail(ClientError::Protocol);
                }
                let Some(deadline) = now.monotonic_ms.checked_add(challenge_ms) else {
                    return self.fail(ClientError::Uncertain);
                };
                self.monotonic_deadline = Some(deadline.min(request_deadline));
                self.prepared = Some(*value);
                if self.view().is_err() {
                    return self.fail(ClientError::ScopeChanged);
                }
                Ok(Event::Prepared)
            }
            Ok(Response::Ticket(ticket)) if matches!(kind, Kind::Complete) => {
                self.eligible(now)?;
                if self.cancel_sent {
                    return self.fail(ClientError::Uncertain);
                }
                Ok(Event::Ticket(ticket))
            }
            Ok(Response::Cancelled(_)) if matches!(kind, Kind::Cancel) => {
                Ok(Event::CancelAcknowledged)
            }
            _ => self.fail(ClientError::Protocol),
        }
    }

    pub fn view(&self) -> Result<GrantView, ClientError> {
        let p = self.prepared.as_ref().ok_or(ClientError::NotPrepared)?;
        let display = &p.display_scope;
        GrantView::new(
            [
                &display.profile_label,
                &display.conversation_label,
                &display.producer_label,
            ],
            p.expires_at,
            p.max_admissions,
        )
        .map_err(|_| ClientError::ScopeChanged)
    }

    pub fn attempted_sequences(&self) -> Vec<u64> {
        self.attempts.iter().map(|a| a.sequence).collect()
    }
    pub fn is_sealed(&self) -> bool {
        self.lane.is_sealed() || self.lineage.is_sealed()
    }
    pub fn transport_lost(&mut self) {
        self.lane.close();
        self.lineage.seal();
    }
    pub fn eof(&mut self) -> Result<(), ClientError> {
        let error = if self.packets.finish().is_ok() {
            ClientError::Uncertain
        } else {
            ClientError::Protocol
        };
        self.fail(error)
    }
}

#[cfg(test)]
#[path = "native_consent_fixtures_tests.rs"]
mod fixtures;
#[cfg(test)]
#[path = "native_consent_client_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "native_consent_write_tests.rs"]
mod write_tests;
