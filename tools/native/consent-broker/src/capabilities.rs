use crate::Prepared;
use std::sync::{Arc, atomic::AtomicBool};

/// Future private OS/code-custody adapter only. Safe external callers cannot
/// construct, deserialize or clone an attachment. The Arc is in-process lineage,
/// not OS identity or evidence of an authenticated connection.
/// ```compile_fail
/// let attachment: stellar_consent_broker::Attachment = serde_json::from_str("{}").unwrap();
/// ```
/// ```compile_fail
/// fn copy(a: stellar_consent_broker::Attachment) { let _ = a.clone(); }
/// ```
pub struct Attachment {
    pub(crate) identity: [u8; 32],
    pub(crate) policy: [u8; 32],
    pub(crate) generation: u64,
    pub(crate) scope: Prepared,
    pub(crate) alive: bool,
    pub(crate) token: Arc<()>,
    pub(crate) flow_claimed: AtomicBool,
}

/// Owned callback association, not a serializable OS verification result.
/// ```compile_fail
/// let callback = stellar_consent_broker::Verification { attachment: [0;32], generation: 1, digest: [0;32] };
/// ```
pub struct Verification {
    pub(crate) attachment: [u8; 32],
    pub(crate) generation: u64,
    pub(crate) digest: [u8; 32],
    pub(crate) token: Arc<()>,
}

/// Internal effect intent, never a host consent ticket or wire response.
/// ```compile_fail
/// fn twice(i: stellar_consent_broker::GrantIntent) { let _ = i.clone(); }
/// ```
pub struct GrantIntent {
    pub(crate) attachment: [u8; 32],
    pub(crate) generation: u64,
    pub(crate) digest: [u8; 32],
    pub(crate) challenge: String,
    pub(crate) token: Arc<()>,
}

/// A future private authenticated host-reply adapter must create this association.
/// Decoding a success-shaped JSON response never creates it.
/// ```compile_fail
/// let success: stellar_consent_broker::HostConsumeSuccess = serde_json::from_str("{}").unwrap();
/// ```
/// ```compile_fail
/// fn copy(h: stellar_consent_broker::HostConsumeSuccess) { let _ = h.clone(); }
/// ```
pub struct HostConsumeSuccess {
    pub(crate) attachment: [u8; 32],
    pub(crate) generation: u64,
    pub(crate) digest: [u8; 32],
    pub(crate) challenge: String,
    pub(crate) token: Arc<()>,
}
