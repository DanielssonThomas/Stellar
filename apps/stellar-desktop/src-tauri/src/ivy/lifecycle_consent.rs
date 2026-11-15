use super::{
    contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_custody::*, lifecycle_ports::*,
};
use serde_json::json;

impl LifecycleCustody {
    /// Native-only entry point; no renderer ticket/gesture/Origin input exists.
    /// Missing attested native UI adapter returns ApprovalRequired before bind.
    pub fn consent(&mut self, ports: &mut impl LifecyclePorts) -> Result<(), IvyErrorCode> {
        self.connection(ports)?;
        if self.state.bind_uncertain.is_some() || self.state.bindings.len() == 20 {
            return Err(IvyErrorCode::Uncertain);
        }
        let ticket = ports.consent_ticket(&self.state.session)?;
        require(hex(&ticket, 64))?;
        self.state.bind_uncertain = Some(operation()?);
        self.save()?;
        // Any failure after this durable intent leaves the bind uncertain. There
        // is no lookup-by-ticket/idempotent bind in 474c1b8: do not retry it.
        let binding: Binding = serde_json::from_value(ports.rpc(
            "stellar.background.bind",
            json!({
                "session_id":self.state.session,"consentTicket":ticket
            }),
        )?)
        .map_err(|_| IvyErrorCode::Protocol)?;
        let now = ports.now()?;
        require(
            binding.valid()
                && binding.origin.profile_id == profile()
                && binding.origin.session_id == self.state.session
                && !binding.revoked
                && binding.created_at <= now
                && now < binding.expires_at
                && !self
                    .state
                    .bindings
                    .iter()
                    .any(|b| b.binding_id == binding.binding_id),
        )?;
        self.state.bindings.push(binding);
        self.state.bind_uncertain = None;
        self.save()
    }
}
