use super::contracts::IvyErrorCode;
pub use super::lifecycle_effect_contracts::{IvyLifecycleKind, IvyLifecycleLease};
use serde_json::Value;

impl IvyLifecycleKind {
    pub(super) fn wire(self) -> &'static str {
        match self {
            Self::Render => "render",
            Self::Speech => "speech",
        }
    }
}

/// Trusted native adapters only. There is deliberately no Tauri/model registration.
/// A ticket must come from Host.approve on this exact authenticated connection.
/// apply retains the resource; stop succeeds only after removal/playback stop and
/// all queued work for this operation can no longer apply. Errors are uncertainty.
/// apply returns after acceptance without blocking on playback or holding custody
/// through a renderer completion Promise. Physical completion is a separate
/// relinquish call; refresh/revoke must remain available while resources are held.
pub trait LifecyclePorts {
    fn transport(&self) -> &str;
    fn now(&self) -> Result<u64, IvyErrorCode>;
    fn consent_ticket(&mut self, session: &str) -> Result<String, IvyErrorCode>;
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, IvyErrorCode>;
    fn apply(&mut self, lease: &IvyLifecycleLease) -> Result<(), IvyErrorCode>;
    fn stop(&mut self, operation: &str, kind: IvyLifecycleKind) -> Result<(), IvyErrorCode>;
}
