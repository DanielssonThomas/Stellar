use super::contracts::IvyErrorCode;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct IdentifierPolicy {
    #[serde(rename = "unicodeVersion")]
    _unicode_version: String,
    non_printable_ranges: Vec<[u32; 2]>,
}

static IDENTIFIERS: LazyLock<Option<IdentifierPolicy>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/lifecycle-identifier-policy.json"
    ))
    .ok()
});

pub(super) const CAPABILITY: &str = "stellar.background.v1";
pub(super) const CONTRACT_SHA256: &str =
    "008c72c917a981672e4ff5e08e54780484c784169cf91d2757fc62dc283ec724";
pub(super) const INTERFACE_SHA256: &str =
    "392c027ac8a5ba92873b1d0958a255bfb6cdd73f2a11b5d7b8ac3b97f066821e";
pub(super) const SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Origin {
    pub profile_id: String,
    pub session_id: String,
    pub physical_target: String,
    pub route: String,
    pub producer_id: String,
    pub worker_incarnation: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Binding {
    pub binding_id: String,
    pub origin: Origin,
    pub consent_revision: u64,
    pub expires_at: u64,
    pub max_admissions: u64,
    pub spent: u64,
    pub revoked: bool,
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Descriptor {
    pub schema_version: u16,
    pub capability: String,
    pub kind: String,
    pub binding_id: String,
    pub event_id: String,
    pub digest: String,
    pub origin: Origin,
    pub consent_revision: u64,
    pub expires_at: u64,
    pub max_admissions: u64,
    pub event_expires_at: u64,
}

pub(super) fn id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.chars().all(|c| {
            if c.is_whitespace() {
                return false;
            }
            let Some(policy) = IDENTIFIERS.as_ref() else {
                return false;
            };
            let n = u32::from(c);
            let at = policy.non_printable_ranges.partition_point(|r| r[1] < n);
            policy.non_printable_ranges.get(at).is_none_or(|r| n < r[0])
        })
}

pub(super) fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(super) fn require(valid: bool) -> Result<(), IvyErrorCode> {
    valid.then_some(()).ok_or(IvyErrorCode::Protocol)
}

impl Origin {
    pub fn valid(&self) -> bool {
        [
            &self.profile_id,
            &self.session_id,
            &self.physical_target,
            &self.route,
            &self.producer_id,
        ]
        .into_iter()
        .all(|s| id(s, 512))
            && hex(&self.worker_incarnation, 32)
    }
}

impl Binding {
    pub fn valid(&self) -> bool {
        hex(&self.binding_id, 32)
            && self.origin.valid()
            && (1..=SAFE).contains(&self.consent_revision)
            && self.created_at < self.expires_at
            && self.expires_at <= SAFE
            && self.expires_at - self.created_at <= 604_800_000
            && (1..=100).contains(&self.max_admissions)
            && self.spent <= self.max_admissions
    }
}

impl Descriptor {
    pub fn same_binding(&self, other: &Self) -> bool {
        self.binding_id == other.binding_id
            && self.origin == other.origin
            && self.consent_revision == other.consent_revision
            && self.expires_at == other.expires_at
            && self.max_admissions == other.max_admissions
    }
    pub fn valid(&self) -> bool {
        self.schema_version == 1
            && self.capability == CAPABILITY
            && self.kind == "lifecycle_update"
            && hex(&self.binding_id, 32)
            && id(&self.event_id, 256)
            && hex(&self.digest, 64)
            && self.origin.valid()
            && (1..=SAFE).contains(&self.consent_revision)
            && self.expires_at <= SAFE
            && self.event_expires_at > 0
            && self.event_expires_at <= self.expires_at
            && (1..=100).contains(&self.max_admissions)
    }

    pub fn bound_to(&self, binding: &Binding) -> bool {
        self.valid()
            && binding.valid()
            && self.binding_id == binding.binding_id
            && self.origin == binding.origin
            && self.consent_revision == binding.consent_revision
            && self.expires_at == binding.expires_at
            && self.max_admissions == binding.max_admissions
            && self.event_expires_at > binding.created_at
    }
}
