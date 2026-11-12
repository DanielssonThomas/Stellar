use super::{
    contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_receipt::*, lifecycle_store::Staging,
    session::Session,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) fn checked_response(method: &str, value: Value) -> Result<Value, IvyErrorCode> {
    match method {
        "session.background.effect.begin" => {
            let result: EffectBegin =
                serde_json::from_value(value.clone()).map_err(|_| IvyErrorCode::Protocol)?;
            result.validate()?;
        }
        "session.background.effect.finish" | "session.background.revoke" => {
            let result: Revocation =
                serde_json::from_value(value.clone()).map_err(|_| IvyErrorCode::Protocol)?;
            result.validate()?;
        }
        _ => {}
    }
    Ok(value)
}

fn now() -> Result<u64, IvyErrorCode> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| IvyErrorCode::Uncertain)?
        .as_millis();
    u64::try_from(millis).map_err(|_| IvyErrorCode::Uncertain)
}

impl Session {
    pub(super) fn lifecycle_fence(&self, params: &Value) -> Result<(), IvyErrorCode> {
        let Some(sid) = self.record.session_id.as_deref() else {
            return Ok(());
        };
        let Some(admission) = params.get("admission_id").and_then(Value::as_str) else {
            return Ok(());
        };
        let path = self.lifecycle_path(sid);
        if !path.exists() {
            return Ok(());
        }
        let state = Staging::load(&path, sid)?;
        if let Some(entry) = state
            .entries
            .iter()
            .find(|e| e.receipt.admission_id == admission)
        {
            let descriptor: Descriptor = serde_json::from_value(
                params
                    .pointer("/payload/background_v1")
                    .cloned()
                    .ok_or(IvyErrorCode::Protocol)?,
            )
            .map_err(|_| IvyErrorCode::Protocol)?;
            require(descriptor == entry.descriptor)?;
        }
        Ok(())
    }
    fn lifecycle_path(&self, sid: &str) -> std::path::PathBuf {
        let hash = format!("{:x}", Sha256::digest(sid.as_bytes()));
        self.journal
            .updates_path()
            .with_file_name(format!("ivy-lifecycle-{hash}.json"))
    }

    fn inspect_lifecycle(
        &mut self,
        descriptor: &Descriptor,
    ) -> Result<(Binding, Inspection), IvyErrorCode> {
        let profile = if cfg!(windows) {
            r"D:\Hermes\profiles\ivy"
        } else {
            "D:/Hermes/profiles/ivy"
        };
        require(
            self.broker.as_ref().is_some_and(|b| b.lifecycle_capable())
                && descriptor.valid()
                && descriptor.origin.profile_id == profile
                && self.record.session_id.as_deref() == Some(&descriptor.origin.session_id),
        )?;
        let sid = &descriptor.origin.session_id;
        let bindings = self.call("session.background.bindings", json!({"session_id":sid}))?;
        require(bindings.as_object().is_some_and(|v| v.len() == 1))?;
        let bindings: Vec<Binding> = serde_json::from_value(
            bindings
                .get("bindings")
                .cloned()
                .ok_or(IvyErrorCode::Protocol)?,
        )
        .map_err(|_| IvyErrorCode::Protocol)?;
        require(
            bindings.len() <= 20
                && bindings.iter().all(|b| {
                    b.valid() && b.origin.session_id == *sid && b.origin.profile_id == profile
                }),
        )?;
        require(
            !bindings
                .iter()
                .enumerate()
                .any(|(i, b)| bindings[..i].iter().any(|p| p.binding_id == b.binding_id)),
        )?;
        let binding = bindings
            .into_iter()
            .find(|b| b.binding_id == descriptor.binding_id)
            .ok_or(IvyErrorCode::Uncertain)?;
        require(descriptor.bound_to(&binding))?;
        let path = self.lifecycle_path(sid);
        if path.exists() {
            let mut state = Staging::load(&path, sid)?;
            if state.latch_denial(&binding, now()?)? {
                state.save(&path)?;
            }
        }
        let inspection: Inspection = serde_json::from_value(self.call("session.background.inspect", json!({
            "session_id":sid,"binding_id":descriptor.binding_id,"event_id":descriptor.event_id,"digest":descriptor.digest
        }))?).map_err(|_| IvyErrorCode::Protocol)?;
        inspection.validate(descriptor)?;
        Ok((binding, inspection))
    }

    pub(super) fn resume_lifecycle(&mut self) -> Result<(), IvyErrorCode> {
        let Some(sid) = self.record.session_id.clone() else {
            return Ok(());
        };
        // Removing a capability never deletes retained proof or implies stopped effects.
        if !self.broker.as_ref().is_some_and(|b| b.lifecycle_capable()) {
            return Ok(());
        }
        let path = self.lifecycle_path(&sid);
        if !path.exists() {
            return Ok(());
        }
        let state = Staging::load(&path, &sid)?;
        let Some((epoch, seq)) = state.cursor.clone() else {
            return Ok(());
        };
        for previous in state.entries.clone() {
            let (binding, inspection) = self.inspect_lifecycle(&previous.descriptor)?;
            let mut state = Staging::load(&path, &sid)?;
            state.observe(&binding, inspection, &epoch, seq, now()?)?;
            state.save(&path)?;
        }
        Ok(())
    }

    pub(super) fn lifecycle_event(&mut self, params: &Value) -> Result<bool, IvyErrorCode> {
        let Some(raw) = params.pointer("/payload/background_v1") else {
            return Ok(false);
        };
        require(
            matches!(
                params.get("type").and_then(Value::as_str),
                Some("message.start" | "message.complete")
            ) && params
                .get("payload")
                .and_then(Value::as_object)
                .is_some_and(|v| v.len() == 1),
        )?;
        let descriptor: Descriptor =
            serde_json::from_value(raw.clone()).map_err(|_| IvyErrorCode::Protocol)?;
        let (binding, inspection) = self.inspect_lifecycle(&descriptor)?;
        let receipt = inspection.receipt.as_ref().ok_or(IvyErrorCode::Uncertain)?;
        require(self.record.admission_id.as_deref() != Some(&receipt.admission_id))?;
        let legacy = super::update_store::Updates::load(
            &self.journal.updates_path(),
            &descriptor.origin.session_id,
        )?;
        require(
            !legacy.pending.iter().any(|e| e.id == receipt.admission_id)
                && !legacy
                    .completed
                    .iter()
                    .any(|e| e.id == receipt.admission_id),
        )?;
        require(
            params.get("admission_id").and_then(Value::as_str) == Some(&receipt.admission_id)
                && params.get("authority_epoch").and_then(Value::as_u64) == receipt.authority_epoch
                && receipt.authority_epoch.is_some()
                && params.get("execution_generation").and_then(Value::as_u64)
                    == receipt.execution_generation
                && receipt.execution_generation.is_some(),
        )?;
        let epoch = params
            .get("replay_epoch")
            .and_then(Value::as_str)
            .ok_or(IvyErrorCode::Protocol)?;
        let seq = params
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or(IvyErrorCode::Protocol)?;
        let sid = &descriptor.origin.session_id;
        let path = self.lifecycle_path(sid);
        let mut state = Staging::load(&path, sid)?;
        if receipt.sequence <= legacy.settled_sequence
            && !state
                .entries
                .iter()
                .any(|e| e.receipt.admission_id == receipt.admission_id)
        {
            return Err(IvyErrorCode::Uncertain);
        }
        state.observe(&binding, inspection, epoch, seq, now()?)?;
        state.save(&path)?;
        // Inspection and staging never authorize renderer or speech effects.
        Ok(true)
    }
}
