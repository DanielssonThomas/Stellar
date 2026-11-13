use super::{
    contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_custody::*, lifecycle_ports::*,
    lifecycle_receipt::*,
};
use serde_json::json;
use sha2::{Digest, Sha256};

impl LifecycleCustody {
    pub(super) fn staging_path(&self) -> std::path::PathBuf {
        let hash = format!("{:x}", Sha256::digest(self.state.session.as_bytes()));
        self.path
            .with_file_name(format!("ivy-lifecycle-{hash}.json"))
    }

    fn staged(&self, admission: &str) -> Result<Inspection, IvyErrorCode> {
        require(id(admission, 512))?;
        let staging =
            super::lifecycle_store::Staging::load(&self.staging_path(), &self.state.session)?;
        let entry = staging
            .entries
            .into_iter()
            .find(|entry| entry.receipt.admission_id == admission)
            .ok_or(IvyErrorCode::Unavailable)?;
        if entry.withheld {
            return Err(IvyErrorCode::Uncertain);
        }
        let inspection = Inspection {
            schema_version: 1,
            status: "terminal".into(),
            retry_authorized: false,
            descriptor: Some(entry.descriptor.clone()),
            delivery_authorized: Some(true),
            receipt: Some(entry.receipt),
        };
        inspection.validate(&entry.descriptor)?;
        Ok(inspection)
    }
    fn deny(&mut self, binding: &str) -> Result<(), IvyErrorCode> {
        if !self.state.denied.iter().any(|b| b == binding) {
            self.state.denied.push(binding.into());
        }
        self.save()
    }
    fn inspect(
        &self,
        ports: &mut impl LifecyclePorts,
        d: &Descriptor,
    ) -> Result<Inspection, IvyErrorCode> {
        self.connection(ports)?;
        let value = ports.rpc(
            "stellar.background.inspect",
            json!({"session_id":self.state.session,
            "bindingId":d.binding_id,"eventId":d.event_id,"digest":d.digest}),
        )?;
        let inspection: Inspection =
            serde_json::from_value(value).map_err(|_| IvyErrorCode::Protocol)?;
        inspection.validate(d)?;
        Ok(inspection)
    }

    /// Load only retained, non-withheld native evidence for this exact admission.
    /// Each kind has a single durable intent; unknown/finished never executes again.
    pub fn deliver(
        &mut self,
        ports: &mut impl LifecyclePorts,
        admission: &str,
        kind: IvyLifecycleKind,
    ) -> Result<(), IvyErrorCode> {
        self.connection(ports)?;
        let staged = self.staged(admission)?;
        let d = staged.descriptor.clone().ok_or(IvyErrorCode::Protocol)?;
        staged.validate(&d)?;
        require(staged.delivery_authorized == Some(true))?;
        let binding = self
            .state
            .bindings
            .iter()
            .find(|b| b.binding_id == d.binding_id)
            .ok_or(IvyErrorCode::ApprovalRequired)?;
        let now = ports.now()?;
        require(
            d.bound_to(binding)
                && !binding.revoked
                && now >= binding.created_at
                && now < d.event_expires_at
                && !self.state.denied.contains(&d.binding_id),
        )?;
        if self.state.bind_uncertain.is_some()
            || self.state.intents.len() == 32
            || self.state.intents.iter().any(|i| {
                i.descriptor.binding_id == d.binding_id
                    && i.descriptor.event_id == d.event_id
                    && i.kind == kind
            })
        {
            return Err(IvyErrorCode::Uncertain);
        }
        let inspection = self.inspect(ports, &d)?;
        let verified = require(
            inspection.delivery_authorized == Some(true) && inspection.receipt == staged.receipt,
        );
        if let Err(error) = verified {
            self.deny(&d.binding_id)?;
            return Err(error);
        }
        let receipt = inspection.receipt.ok_or(IvyErrorCode::Protocol)?;
        let operation = operation()?;
        self.state.intents.push(Intent {
            descriptor: d.clone(),
            receipt,
            operation: operation.clone(),
            transport: self.transport.clone(),
            kind,
            phase: Phase::Pending,
        });
        self.save()?;
        let at = self.state.intents.len() - 1;
        let begin: EffectBegin = serde_json::from_value(ports.rpc(
            "stellar.background.effect.begin",
            json!({
                "session_id":self.state.session,"bindingId":d.binding_id,"eventId":d.event_id,
                "digest":d.digest,"operation":operation,"kind":kind.wire()
            }),
        )?)
        .map_err(|_| IvyErrorCode::Protocol)?;
        begin.validate()?;
        if !begin.execute {
            if begin.status == "finished" {
                self.state.intents[at].phase = Phase::Finished;
                self.save()?;
            } else {
                // Unknown still owns unfinished custody. Do not apply/rebegin;
                // fence even an absent local effect before exact-owner finish.
                let _ = self.stop_intent(ports, at);
            }
            return Err(IvyErrorCode::Uncertain);
        }
        self.state.intents[at].phase = Phase::Claimed;
        self.save()?;
        // Recheck after begin before applying. A denial/error cancels locally;
        // finish requires the adapter's physical stop/queued-work acknowledgement.
        let current = self.inspect(ports, &d).and_then(|i| {
            require(
                i.delivery_authorized == Some(true)
                    && i.receipt.as_ref() == Some(&self.state.intents[at].receipt)
                    && self.staged(admission)? == staged
                    && ports.now()? < d.event_expires_at,
            )
        });
        if let Err(error) = current {
            let _ = self.deny(&d.binding_id);
            let _ = self.stop_intent(ports, at);
            return Err(error);
        }
        let lease = IvyLifecycleLease {
            operation,
            kind,
            text: self.state.intents[at]
                .receipt
                .result
                .as_ref()
                .ok_or(IvyErrorCode::Protocol)?
                .final_response
                .clone(),
        };
        if let Err(error) = ports.apply(&lease) {
            let _ = self.stop_intent(ports, at);
            return Err(error);
        }
        Ok(())
    }

    fn stop_local(
        &mut self,
        ports: &mut impl LifecyclePorts,
        at: usize,
    ) -> Result<(), IvyErrorCode> {
        let intent = self.state.intents[at].clone();
        // Exact local cancellation is permitted after transport loss. Only
        // remote finish below requires the original authenticated transport.
        if matches!(intent.phase, Phase::Stopped | Phase::Finished) {
            return Ok(());
        }
        // A lost begin ACK may still own custody. stop must fence even work that
        // never appeared locally; only the original transport may finish it.
        ports.stop(&intent.operation, intent.kind)?;
        self.state.intents[at].phase = Phase::Stopped;
        self.save()
    }

    fn finish_intent(
        &mut self,
        ports: &mut impl LifecyclePorts,
        at: usize,
    ) -> Result<(), IvyErrorCode> {
        self.connection(ports)?;
        let intent = self.state.intents[at].clone();
        if intent.transport != self.transport {
            return Err(IvyErrorCode::Uncertain);
        }
        if matches!(intent.phase, Phase::Finished) {
            return Ok(());
        }
        require(intent.phase == Phase::Stopped)?;
        let result: Revocation = serde_json::from_value(ports.rpc("stellar.background.effect.finish", json!({
            "session_id":self.state.session,"bindingId":intent.descriptor.binding_id,
            "eventId":intent.descriptor.event_id,"operation":intent.operation,"kind":intent.kind.wire()
        }))?).map_err(|_| IvyErrorCode::Protocol)?;
        result.validate()?;
        // active/false/false is a valid exact-operation finish ACK; it does not
        // assert aggregate revocation or a different transport's physical stop.
        self.state.intents[at].phase = Phase::Finished;
        self.save()
    }

    fn stop_intent(
        &mut self,
        ports: &mut impl LifecyclePorts,
        at: usize,
    ) -> Result<(), IvyErrorCode> {
        self.stop_local(ports, at)?;
        self.finish_intent(ports, at)
    }

    pub fn relinquish(
        &mut self,
        ports: &mut impl LifecyclePorts,
        operation: &str,
    ) -> Result<(), IvyErrorCode> {
        let at = self
            .state
            .intents
            .iter()
            .position(|i| i.operation == operation)
            .ok_or(IvyErrorCode::Unavailable)?;
        self.stop_intent(ports, at)
    }

    /// A future active adapter must call this while any resource is held. A read
    /// outage is local cancellation, never proof of revocation or host stop.
    pub fn refresh(&mut self, ports: &mut impl LifecyclePorts) -> Result<(), IvyErrorCode> {
        let connected = self.connection(ports).is_ok();
        let mut failure = None;
        let mut stopping = vec![];
        for at in 0..self.state.intents.len() {
            let intent = self.state.intents[at].clone();
            if matches!(intent.phase, Phase::Finished) {
                continue;
            }
            if !connected || intent.transport != self.transport {
                let _ = self.stop_local(ports, at);
                failure = Some(IvyErrorCode::Uncertain);
                continue;
            }
            let retained = self.staged(&intent.receipt.admission_id).is_ok_and(|i| {
                i.descriptor.as_ref() == Some(&intent.descriptor)
                    && i.receipt.as_ref() == Some(&intent.receipt)
            });
            let allowed = retained
                && self.inspect(ports, &intent.descriptor).is_ok_and(|i| {
                    i.delivery_authorized == Some(true)
                        && i.receipt.as_ref() == Some(&intent.receipt)
                        && ports
                            .now()
                            .is_ok_and(|now| now < intent.descriptor.event_expires_at)
                        && !self.state.denied.contains(&intent.descriptor.binding_id)
                });
            if !allowed || intent.phase != Phase::Claimed {
                if !allowed && let Err(error) = self.deny(&intent.descriptor.binding_id) {
                    failure = Some(error);
                }
                stopping.push(at);
                if let Err(error) = self.stop_local(ports, at) {
                    failure = Some(error);
                }
            }
        }
        for at in stopping {
            if self.state.intents[at].phase == Phase::Stopped
                && let Err(error) = self.finish_intent(ports, at)
            {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub fn revoke(
        &mut self,
        ports: &mut impl LifecyclePorts,
        binding: &str,
    ) -> Result<(), IvyErrorCode> {
        require(self.state.bindings.iter().any(|b| b.binding_id == binding))?;
        let mut stopped = self.deny(binding);
        // Fence every local resource before waiting on any remote revoke/finish ACK.
        for at in 0..self.state.intents.len() {
            if self.state.intents[at].descriptor.binding_id == binding
                && let Err(error) = self.stop_local(ports, at)
            {
                stopped = Err(error);
            }
        }
        self.connection(ports)?;
        let remote = ports
            .rpc(
                "stellar.background.revoke",
                json!({"session_id":self.state.session,"bindingId":binding}),
            )
            .and_then(|v| {
                serde_json::from_value::<Revocation>(v).map_err(|_| IvyErrorCode::Protocol)
            })
            .and_then(|v| {
                v.validate()?;
                require(v.revocation_committed)
            });
        for at in 0..self.state.intents.len() {
            if self.state.intents[at].descriptor.binding_id == binding
                && self.state.intents[at].phase == Phase::Stopped
                && let Err(error) = self.finish_intent(ports, at)
            {
                stopped = Err(error);
            }
        }
        remote.and(stopped)
    }
}
