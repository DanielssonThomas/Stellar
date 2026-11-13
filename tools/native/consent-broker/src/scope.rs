use crate::protocol::{Error, MAX_SAFE_INTEGER, hex};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub profile_id: String,
    pub session_id: String,
    pub physical_target: String,
    pub route: String,
    pub producer_id: String,
    pub worker_incarnation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayScope {
    pub profile_label: String,
    pub conversation_label: String,
    pub producer_label: String,
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepared {
    pub version: u8,
    pub challenge_id: String,
    pub connection_binding: String,
    pub origin: Origin,
    pub display_scope: DisplayScope,
    pub expires_at: u64,
    pub max_admissions: u32,
    pub challenge_expires_at: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ticket {
    pub consent_ticket: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cancelled {
    pub cancelled: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Response {
    Prepared(Box<Prepared>),
    Ticket(Ticket),
    Cancelled(Cancelled),
}

pub(crate) fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.chars().all(|c| printable(c) && !c.is_whitespace())
}

fn printable(c: char) -> bool {
    // Generated from all scalars in the pinned CPython Unicode-16 baseline.
    let ranges = include_bytes!("../data/printable-16.bin");
    let point = u32::from(c);
    let mut low = 0;
    let mut high = ranges.len() / 8;
    while low < high {
        let mid = (low + high) / 2;
        let pair = &ranges[mid * 8..mid * 8 + 8];
        let first = u32::from_le_bytes([pair[0], pair[1], pair[2], pair[3]]);
        let last = u32::from_le_bytes([pair[4], pair[5], pair[6], pair[7]]);
        if point < first {
            high = mid;
        } else if point > last {
            low = mid + 1;
        } else {
            return true;
        }
    }
    false
}

fn label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

impl Origin {
    pub fn validate(&self) -> Result<(), Error> {
        if [
            &self.profile_id,
            &self.session_id,
            &self.physical_target,
            &self.route,
            &self.producer_id,
        ]
        .iter()
        .all(|v| identifier(v, 512))
            && hex(&self.worker_incarnation, 32)
        {
            Ok(())
        } else {
            Err(Error::InvalidRequest)
        }
    }
}

impl Prepared {
    pub fn validate(&self) -> Result<(), Error> {
        self.origin.validate()?;
        let display = &self.display_scope;
        if self.version != 1
            || !hex(&self.challenge_id, 64)
            || !hex(&self.connection_binding, 64)
            || ![
                &display.profile_label,
                &display.conversation_label,
                &display.producer_label,
            ]
            .iter()
            .all(|v| label(v))
            || display.effects != ["render", "speech"]
            || !(1..=100).contains(&self.max_admissions)
            || self.expires_at > MAX_SAFE_INTEGER
            || self.challenge_expires_at > MAX_SAFE_INTEGER
            || self.challenge_expires_at == 0
            || self.expires_at < self.challenge_expires_at
        {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
}

impl Response {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Prepared(value) => value.validate(),
            Self::Ticket(value) if hex(&value.consent_ticket, 64) => Ok(()),
            Self::Cancelled(value) if value.cancelled => Ok(()),
            _ => Err(Error::InvalidRequest),
        }
    }
}
