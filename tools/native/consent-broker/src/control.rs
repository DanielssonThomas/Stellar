use crate::packet::packet;
use crate::protocol::{Error, ErrorReply, MAX_SAFE_INTEGER, Request, decode};
use crate::scope::{Cancelled, Prepared, Response, Ticket};
use serde::{Deserialize, Serialize};

/// Closed v3 control data, not a native connection or permission to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub version: u8,
    pub sequence: u64,
    pub request: Request,
}

impl ControlRequest {
    pub fn new(sequence: u64, request: Request) -> Result<Self, Error> {
        let value = Self {
            version: 3,
            sequence,
            request,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.version != 3 || !(1..=MAX_SAFE_INTEGER).contains(&self.sequence) {
            return Err(Error::InvalidRequest);
        }
        self.request.validate()
    }
}

pub fn decode_control_request(payload: &[u8]) -> Result<ControlRequest, Error> {
    let request: ControlRequest = decode(payload)?;
    request.validate()?;
    Ok(request)
}

pub fn encode_control_request(request: &ControlRequest) -> Result<Vec<u8>, Error> {
    request.validate()?;
    packet(serde_json::to_vec(request).map_err(|_| Error::InvalidRequest)?)
}

#[derive(Debug, PartialEq, Eq)]
pub struct ControlReply {
    pub sequence: u64,
    pub outcome: Result<Response, Error>,
}

#[derive(Default)]
enum Field<T> {
    #[default]
    Missing,
    Value(T),
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Field<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        T::deserialize(d).map(Self::Value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, bound(deserialize = "T: Deserialize<'de>"))]
struct ReplyEnvelope<T> {
    version: u8,
    sequence: u64,
    #[serde(default)]
    result: Field<T>,
    #[serde(default)]
    error: Field<ErrorReply>,
}

/// First pass extracts correlation only. The same ORIGINAL bytes are then decoded
/// by the method-specific type, preserving nested duplicate-field rejection.
pub(crate) fn reply_sequence(payload: &[u8]) -> Result<u64, Error> {
    let envelope: ReplyEnvelope<serde::de::IgnoredAny> = decode(payload)?;
    envelope.validate_header()?;
    Ok(envelope.sequence)
}

impl<T> ReplyEnvelope<T> {
    fn validate_header(&self) -> Result<(), Error> {
        if self.version != 3
            || !(1..=MAX_SAFE_INTEGER).contains(&self.sequence)
            || !matches!(
                (&self.result, &self.error),
                (Field::Value(_), Field::Missing) | (Field::Missing, Field::Value(_))
            )
        {
            return Err(Error::InvalidRequest);
        }
        if matches!(&self.error, Field::Value(e) if e.retry_authorized) {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
}

fn typed_reply<T: serde::de::DeserializeOwned>(
    payload: &[u8],
    expected: &ControlRequest,
    wrap: impl FnOnce(T) -> Response,
) -> Result<ControlReply, Error> {
    let envelope: ReplyEnvelope<T> = decode(payload)?;
    envelope.validate_header()?;
    if envelope.sequence != expected.sequence {
        return Err(Error::InvalidRequest);
    }
    let outcome = match (envelope.result, envelope.error) {
        (Field::Value(value), Field::Missing) => {
            let result = wrap(value);
            result.validate()?;
            Ok(result)
        }
        (Field::Missing, Field::Value(error)) => Err(error.code),
        _ => return Err(Error::InvalidRequest),
    };
    Ok(ControlReply {
        sequence: envelope.sequence,
        outcome,
    })
}

pub fn decode_control_reply(
    payload: &[u8],
    expected: &ControlRequest,
) -> Result<ControlReply, Error> {
    expected.validate()?;
    match &expected.request {
        Request::Prepare(_) => typed_reply::<Box<Prepared>>(payload, expected, Response::Prepared),
        Request::Complete(_) => typed_reply::<Ticket>(payload, expected, Response::Ticket),
        Request::Cancel(_) => typed_reply::<Cancelled>(payload, expected, Response::Cancelled),
    }
}

pub(crate) fn matches_result(request: &Request, response: &Response) -> bool {
    matches!(
        (request, response),
        (Request::Prepare(_), Response::Prepared(_))
            | (Request::Complete(_), Response::Ticket(_))
            | (Request::Cancel(_), Response::Cancelled(_))
    )
}

/// Encoding supplied DTOs is not proof of host issuance or native verification.
pub fn encode_control_reply(
    expected: &ControlRequest,
    outcome: Result<&Response, Error>,
) -> Result<Vec<u8>, Error> {
    #[derive(Serialize)]
    struct Success<'a, T> {
        version: u8,
        sequence: u64,
        result: &'a T,
    }
    #[derive(Serialize)]
    struct Failure {
        version: u8,
        sequence: u64,
        error: ErrorReply,
    }
    expected.validate()?;
    let sequence = expected.sequence;
    let bytes = match outcome {
        Err(code) => serde_json::to_vec(&Failure {
            version: 3,
            sequence,
            error: ErrorReply {
                code,
                retry_authorized: false,
            },
        }),
        Ok(response) => {
            response.validate()?;
            if !matches_result(&expected.request, response) {
                return Err(Error::InvalidRequest);
            }
            match response {
                Response::Prepared(result) => serde_json::to_vec(&Success {
                    version: 3,
                    sequence,
                    result,
                }),
                Response::Ticket(result) => serde_json::to_vec(&Success {
                    version: 3,
                    sequence,
                    result,
                }),
                Response::Cancelled(result) => serde_json::to_vec(&Success {
                    version: 3,
                    sequence,
                    result,
                }),
            }
        }
    }
    .map_err(|_| Error::InvalidRequest)?;
    packet(bytes)
}
