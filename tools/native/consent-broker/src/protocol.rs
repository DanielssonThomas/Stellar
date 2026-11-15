use crate::scope::{Response, identifier};
use serde::{Deserialize, Serialize};

pub const MAX_FRAME: usize = 16_384;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const CONTRACT: &str = "008c72c917a981672e4ff5e08e54780484c784169cf91d2757fc62dc283ec724";
pub const HOST_INTERFACE: &str = "392c027ac8a5ba92873b1d0958a255bfb6cdd73f2a11b5d7b8ac3b97f066821e";
pub const SEMANTICS: &str = "75d0f72f9dee1a892aef87a70e4069cad063509e8b2cd26d7bf12f4527a12f77";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Error {
    InvalidRequest,
    ApprovalRequired,
    PeerUnverified,
    HostUnverified,
    VerificationUnavailable,
    VerificationDenied,
    ChallengeUnknown,
    ChallengeExpired,
    ChallengeConsumed,
    ChallengeCancelled,
    OriginChanged,
    PolicyChanged,
    TransportChanged,
    Busy,
    Uncertain,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorReply {
    pub code: Error,
    pub retry_authorized: bool,
}

pub fn decode_error(bytes: &[u8]) -> Result<ErrorReply, Error> {
    let reply: ErrorReply = decode(bytes)?;
    if reply.retry_authorized {
        Err(Error::InvalidRequest)
    } else {
        Ok(reply)
    }
}

pub fn encode_error(code: Error) -> Vec<u8> {
    // All variants and the closed envelope are serializable without caller data.
    serde_json::to_vec(&ErrorReply {
        code,
        retry_authorized: false,
    })
    .expect("fixed error envelope")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "prepareConsent")]
    Prepare(PrepareRequest),
    #[serde(rename = "completeConsent")]
    Complete(ChallengeRequest),
    #[serde(rename = "cancelConsent")]
    Cancel(ChallengeRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChallengeRequest {
    pub challenge_id: String,
}

pub fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn decode_request(bytes: &[u8]) -> Result<Request, Error> {
    let request: Request = decode(bytes)?;
    request.validate()?;
    Ok(request)
}

impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let valid = match self {
            Self::Prepare(p) => identifier(&p.session_id, 512),
            Self::Complete(p) | Self::Cancel(p) => hex(&p.challenge_id, 64),
        };
        if valid {
            Ok(())
        } else {
            Err(Error::InvalidRequest)
        }
    }
}

pub(crate) fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, Error> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(Error::InvalidRequest);
    }
    crate::object_json::check(bytes)?;
    // Direct typed deserialization preserves duplicate-field rejection. No Value/map hop.
    serde_json::from_slice(bytes).map_err(|_| Error::InvalidRequest)
}

/// The caller supplies its outstanding request, not an untrusted response tag.
pub fn decode_response(request: &Request, bytes: &[u8]) -> Result<Response, Error> {
    let response = match request {
        Request::Prepare(_) => Response::Prepared(decode(bytes)?),
        Request::Complete(_) => Response::Ticket(decode(bytes)?),
        Request::Cancel(_) => Response::Cancelled(decode(bytes)?),
    };
    response.validate()?;
    Ok(response)
}

pub fn encode_response(response: &Response) -> Result<Vec<u8>, Error> {
    response.validate()?;
    let bytes = match response {
        Response::Prepared(v) => serde_json::to_vec(v),
        Response::Ticket(v) => serde_json::to_vec(v),
        Response::Cancelled(v) => serde_json::to_vec(v),
    }
    .map_err(|_| Error::InvalidRequest)?;
    if bytes.len() > MAX_FRAME {
        Err(Error::InvalidRequest)
    } else {
        Ok(bytes)
    }
}
