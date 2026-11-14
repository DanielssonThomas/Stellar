use crate::Response;
use crate::control::{
    ControlReply, ControlRequest, decode_control_reply, decode_control_request,
    encode_control_reply, encode_control_request, reply_sequence,
};
use crate::protocol::{Error, MAX_SAFE_INTEGER, Request};

fn is_cancel(request: &Request) -> bool {
    matches!(request, Request::Cancel(_))
}
fn is_complete(request: &Request) -> bool {
    matches!(request, Request::Complete(_))
}

fn room<'a>(requests: impl Iterator<Item = &'a ControlRequest>, incoming: &Request) -> bool {
    let mut count = 0;
    for existing in requests {
        count += 1;
        if is_complete(incoming) && is_complete(&existing.request) {
            return false;
        }
    }
    count < if is_cancel(incoming) { 4 } else { 3 }
}

/// Correlation metadata only. A new lane is not a new authenticated attachment.
/// The future private attachment owner must enforce one lane pair per lifetime.
pub struct ClientLane {
    next: u64,
    pending: Vec<ControlRequest>,
    sealed: bool,
}

impl Default for ClientLane {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientLane {
    pub fn new() -> Self {
        Self {
            next: 1,
            pending: vec![],
            sealed: false,
        }
    }

    /// Reserve correlation BEFORE the caller can write any bytes. No I/O or retry.
    pub fn reserve(&mut self, request: Request) -> Result<(u64, Vec<u8>), Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        if self.next > MAX_SAFE_INTEGER {
            self.sealed = true;
            return Err(Error::Uncertain);
        }
        request.validate()?;
        if !room(self.pending.iter(), &request) {
            return Err(Error::Busy);
        }
        let frame = ControlRequest::new(self.next, request)?;
        let bytes = encode_control_request(&frame)?;
        self.next += 1;
        let sequence = frame.sequence;
        self.pending.push(frame);
        Ok((sequence, bytes))
    }

    /// Takes a single decoded packet PAYLOAD. Invalid/unknown/duplicate replies seal
    /// the lane and retain outstanding identities, rather than enabling a retry.
    pub fn receive(&mut self, payload: &[u8]) -> Result<ControlReply, Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        let result = (|| {
            let sequence = reply_sequence(payload)?;
            let index = self
                .pending
                .iter()
                .position(|r| r.sequence == sequence)
                .ok_or(Error::InvalidRequest)?;
            let reply = decode_control_reply(payload, &self.pending[index])?;
            self.pending.remove(index);
            Ok(reply)
        })();
        if result.is_err() {
            self.sealed = true;
        }
        result
    }

    /// Lost/partial write, timeout, EOF or attachment loss: never release reservations.
    pub fn close(&mut self) {
        self.sealed = true;
    }

    pub fn outstanding(&self) -> Vec<u64> {
        self.pending.iter().map(|r| r.sequence).collect()
    }
    pub fn is_sealed(&self) -> bool {
        self.sealed
    }
}

struct Work {
    frame: ControlRequest,
    running: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Acceptance {
    Queued,
    RejectedBusy,
}

/// Validated input and bounded scheduling outcome, never canonical admission.
pub struct ServerInput {
    pub request: ControlRequest,
    pub disposition: Acceptance,
}

/// Pure scheduling/correlation; it never invokes a UI, verifier or host method.
pub struct ServerLane {
    next: u64,
    work: Vec<Work>,
    sealed: bool,
}

impl Default for ServerLane {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerLane {
    pub fn new() -> Self {
        Self {
            next: 1,
            work: vec![],
            sealed: false,
        }
    }

    /// Even a Busy rejection consumes its input sequence. The caller emits the
    /// bounded Busy error once; replaying that sequence is a protocol violation.
    pub(crate) fn accept(&mut self, frame: ControlRequest) -> Result<Acceptance, Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        if frame.validate().is_err() || frame.sequence != self.next {
            self.sealed = true;
            return Err(Error::InvalidRequest);
        }
        self.next += 1;
        if !room(self.work.iter().map(|w| &w.frame), &frame.request) {
            return Ok(Acceptance::RejectedBusy);
        }
        self.work.push(Work {
            frame,
            running: false,
        });
        Ok(Acceptance::Queued)
    }

    /// Owns decoding and sticky sealing. On Busy, the returned request lets the
    /// caller encode that one bounded error; no replay/retry is authorized.
    pub fn receive(&mut self, payload: &[u8]) -> Result<ServerInput, Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        let result = (|| {
            let request = decode_control_request(payload)?;
            let disposition = self.accept(request.clone())?;
            Ok(ServerInput {
                request,
                disposition,
            })
        })();
        if result.is_err() {
            self.sealed = true;
        }
        result
    }

    /// May run while an earlier complete is outstanding. No lock/await or prompt
    /// blocks selection of the reserved cancellation slot.
    pub fn take_next(&mut self) -> Result<Option<ControlRequest>, Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        let index = self
            .work
            .iter()
            .position(|w| !w.running && is_cancel(&w.frame.request))
            .or_else(|| self.work.iter().position(|w| !w.running));
        Ok(index.map(|i| {
            self.work[i].running = true;
            self.work[i].frame.clone()
        }))
    }

    /// Returns one framed reply; removal is correlation only, never an attempt,
    /// native consent, ticket or effect-custody journal retirement.
    pub fn finish(
        &mut self,
        sequence: u64,
        outcome: Result<&Response, Error>,
    ) -> Result<Vec<u8>, Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        let result = (|| {
            let index = self
                .work
                .iter()
                .position(|w| w.frame.sequence == sequence && w.running)
                .ok_or(Error::InvalidRequest)?;
            let bytes = encode_control_reply(&self.work[index].frame, outcome)?;
            self.work.remove(index);
            Ok(bytes)
        })();
        if result.is_err() {
            self.sealed = true;
        }
        result
    }

    pub fn close(&mut self) {
        self.sealed = true;
    }
    pub fn outstanding(&self) -> Vec<u64> {
        self.work.iter().map(|w| w.frame.sequence).collect()
    }
    pub fn is_sealed(&self) -> bool {
        self.sealed
    }
}

#[cfg(test)]
mod limit_tests {
    use super::*;
    use crate::control_tests::prepare;

    #[test]
    fn sequence_exhaustion_never_wraps_or_releases_outstanding_identity() {
        let mut client = ClientLane {
            next: MAX_SAFE_INTEGER,
            pending: vec![],
            sealed: false,
        };
        assert_eq!(client.reserve(prepare()).unwrap().0, MAX_SAFE_INTEGER);
        assert_eq!(client.reserve(prepare()), Err(Error::Uncertain));
        assert!(client.is_sealed());
        assert_eq!(client.outstanding(), [MAX_SAFE_INTEGER]);
        let mut server = ServerLane {
            next: MAX_SAFE_INTEGER,
            work: vec![],
            sealed: false,
        };
        server
            .accept(ControlRequest::new(MAX_SAFE_INTEGER, prepare()).unwrap())
            .unwrap();
        assert_eq!(
            server.accept(ControlRequest::new(MAX_SAFE_INTEGER, prepare()).unwrap()),
            Err(Error::InvalidRequest)
        );
        assert!(server.is_sealed());
        assert_eq!(server.outstanding(), [MAX_SAFE_INTEGER]);
    }
}
