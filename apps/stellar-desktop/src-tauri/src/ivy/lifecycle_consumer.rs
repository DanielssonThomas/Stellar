use super::{
    contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_receipt::*, lifecycle_store::Staging,
    session::Session,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) fn checked_response(method: &str, value: Value) -> Result<Value, IvyErrorCode> {
    match method {
        "stellar.background.effect.begin" => {
            let result: EffectBegin =
                serde_json::from_value(value.clone()).map_err(|_| IvyErrorCode::Protocol)?;
            result.validate()?;
        }
        "stellar.background.effect.finish" | "stellar.background.revoke" => {
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
            if let Some(raw) = params.pointer("/payload/background_v1") {
                let descriptor: Descriptor =
                    serde_json::from_value(raw.clone()).map_err(|_| IvyErrorCode::Protocol)?;
                require(descriptor == entry.descriptor)?;
            } else {
                require(params.get("type").and_then(Value::as_str) != Some("message.start"))?;
            }
        }
        Ok(())
    }
    pub(super) fn lifecycle_path(&self, sid: &str) -> std::path::PathBuf {
        let hash = format!("{:x}", Sha256::digest(sid.as_bytes()));
        self.journal
            .updates_path()
            .with_file_name(format!("ivy-lifecycle-{hash}.json"))
    }

    pub(super) fn lifecycle_custody_path(&self, sid: &str) -> std::path::PathBuf {
        self.lifecycle_path(sid).with_extension("custody.json")
    }

    fn inspect_lifecycle(
        &mut self,
        descriptor: &Descriptor,
    ) -> Result<(Binding, Inspection), IvyErrorCode> {
        let profile = super::lifecycle_custody::profile();
        require(
            self.broker.as_ref().is_some_and(|b| b.lifecycle_capable())
                && descriptor.valid()
                && descriptor.origin.profile_id == profile
                && self.record.session_id.as_deref() == Some(&descriptor.origin.session_id),
        )?;
        let sid = &descriptor.origin.session_id;
        // Only a validated bind ACK from the native consent path supplies this
        // record. A stream descriptor is never replacement proof of consent.
        let custody = super::lifecycle_custody::LifecycleCustody::read(
            &self.lifecycle_custody_path(sid),
            sid,
        )?;
        if custody.bind_uncertain.is_some() {
            return Err(IvyErrorCode::Uncertain);
        }
        let mut binding = custody
            .bindings
            .into_iter()
            .find(|b| b.binding_id == descriptor.binding_id)
            .ok_or(IvyErrorCode::Uncertain)?;
        binding.revoked |= custody.denied.contains(&binding.binding_id);
        require(descriptor.bound_to(&binding))?;
        let path = self.lifecycle_path(sid);
        if path.exists() {
            let mut state = Staging::load(&path, sid)?;
            if state.latch_denial(&binding, now()?)? {
                state.save(&path)?;
            }
        }
        let inspection: Inspection = serde_json::from_value(self.call("stellar.background.inspect", json!({
            "session_id":sid,"bindingId":descriptor.binding_id,"eventId":descriptor.event_id,"digest":descriptor.digest
        }))?).map_err(|_| IvyErrorCode::Protocol)?;
        inspection.validate(descriptor)?;
        self.lifecycle_receipt(descriptor, &inspection)?;
        Ok((binding, inspection))
    }

    fn lifecycle_receipt(
        &mut self,
        descriptor: &Descriptor,
        inspection: &Inspection,
    ) -> Result<(), IvyErrorCode> {
        let expected = inspection.receipt.as_ref().ok_or(IvyErrorCode::Uncertain)?;
        let mut value = self.call(
            "prompt.receipt",
            json!({"session_id":descriptor.origin.session_id,
            "admission_id":expected.admission_id,"include_result":true}),
        )?;
        let fields = value.as_object_mut().ok_or(IvyErrorCode::Protocol)?;
        require(
            fields.remove("background_v1")
                == Some(serde_json::to_value(descriptor).map_err(|_| IvyErrorCode::Protocol)?),
        )?;
        require(
            fields.remove("background_delivery_authorized")
                == inspection.delivery_authorized.map(Value::Bool),
        )?;
        let receipt: Receipt = serde_json::from_value(value).map_err(|_| IvyErrorCode::Protocol)?;
        require(&receipt == expected)
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
        let kind = params.get("type").and_then(Value::as_str);
        let raw = params.pointer("/payload/background_v1");
        let descriptor: Descriptor = if let Some(raw) = raw {
            require(
                matches!(kind, Some("message.start" | "message.complete"))
                    && params
                        .get("payload")
                        .and_then(Value::as_object)
                        .is_some_and(|v| v.len() == 1),
            )?;
            serde_json::from_value(raw.clone()).map_err(|_| IvyErrorCode::Protocol)?
        } else {
            let Some(sid) = self.record.session_id.as_deref() else {
                return Ok(false);
            };
            let state = Staging::load(&self.lifecycle_path(sid), sid)?;
            let Some(entry) = state.entries.iter().find(|e| {
                params.get("admission_id").and_then(Value::as_str) == Some(&e.receipt.admission_id)
            }) else {
                return Ok(false);
            };
            require(
                params.get("authority_epoch").and_then(Value::as_u64)
                    == entry.receipt.authority_epoch
                    && params.get("execution_generation").and_then(Value::as_u64)
                        == entry.receipt.execution_generation
                    && params.get("replay_epoch").and_then(Value::as_str)
                        == state.cursor.as_ref().map(|(e, _)| e.as_str()),
            )?;
            if kind != Some("message.complete") {
                return Ok(true);
            }
            entry.descriptor.clone()
        };
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
