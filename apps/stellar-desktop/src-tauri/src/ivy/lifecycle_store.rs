use super::{contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_receipt::*};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
    pub descriptor: Descriptor,
    pub receipt: Receipt,
    pub withheld: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Staging {
    pub session: String,
    pub cursor: Option<(String, u64)>,
    pub entries: Vec<Entry>,
}

impl Staging {
    pub fn load(path: &Path, session: &str) -> Result<Self, IvyErrorCode> {
        let state = if path.exists() {
            if fs::metadata(path).map_err(|_| IvyErrorCode::Storage)?.len() > 32 * 1024 * 1024 {
                return Err(IvyErrorCode::Storage);
            }
            serde_json::from_slice(&fs::read(path).map_err(|_| IvyErrorCode::Storage)?)
                .map_err(|_| IvyErrorCode::Storage)?
        } else {
            Self {
                session: session.into(),
                ..Self::default()
            }
        };
        state.validate(session)?;
        Ok(state)
    }

    fn validate(&self, session: &str) -> Result<(), IvyErrorCode> {
        if self.session != session
            || self.entries.len() > 16
            || (!self.entries.is_empty() && self.cursor.is_none())
            || self
                .cursor
                .as_ref()
                .is_some_and(|(e, s)| !id(e, 512) || *s > SAFE)
        {
            return Err(IvyErrorCode::Storage);
        }
        for (i, e) in self.entries.iter().enumerate() {
            let inspection = Inspection {
                schema_version: 1,
                status: if e.receipt.status == "terminal" {
                    "terminal"
                } else {
                    "admitted"
                }
                .into(),
                retry_authorized: false,
                descriptor: Some(e.descriptor.clone()),
                delivery_authorized: Some(e.receipt.status == "terminal" && !e.withheld),
                receipt: Some(e.receipt.clone()),
            };
            if e.descriptor.origin.session_id != session
                || (e.withheld && e.receipt.result.is_some())
                || inspection.validate(&e.descriptor).is_err()
                || self.entries[..i].iter().any(|previous| {
                    previous.receipt.admission_id == e.receipt.admission_id
                        || previous.receipt.sequence == e.receipt.sequence
                        || (previous.descriptor.binding_id == e.descriptor.binding_id
                            && !previous.descriptor.same_binding(&e.descriptor))
                        || (previous.descriptor.binding_id == e.descriptor.binding_id
                            && previous.descriptor.event_id == e.descriptor.event_id)
                })
            {
                return Err(IvyErrorCode::Storage);
            }
        }
        Ok(())
    }

    pub fn latch_denial(&mut self, binding: &Binding, now: u64) -> Result<bool, IvyErrorCode> {
        require(binding.valid())?;
        require(!self.entries.iter().any(|e| {
            e.descriptor.binding_id == binding.binding_id && !e.descriptor.bound_to(binding)
        }))?;
        let mut changed = false;
        for entry in &mut self.entries {
            if entry.descriptor.binding_id == binding.binding_id
                && (binding.revoked
                    || now < binding.created_at
                    || now >= entry.descriptor.event_expires_at)
            {
                changed |= !entry.withheld || entry.receipt.result.is_some();
                entry.withheld = true;
                entry.receipt.result = None;
            }
        }
        Ok(changed)
    }

    pub fn observe(
        &mut self,
        binding: &Binding,
        inspection: Inspection,
        epoch: &str,
        seq: u64,
        now: u64,
    ) -> Result<(), IvyErrorCode> {
        let descriptor = inspection
            .descriptor
            .as_ref()
            .ok_or(IvyErrorCode::Uncertain)?;
        inspection.validate(descriptor)?;
        require(
            descriptor.bound_to(binding)
                && descriptor.origin.session_id == self.session
                && id(epoch, 512)
                && seq <= SAFE,
        )?;
        if self
            .cursor
            .as_ref()
            .is_some_and(|(prior, _)| prior != epoch)
        {
            return Err(IvyErrorCode::Uncertain);
        }
        let receipt = inspection.receipt.as_ref().ok_or(IvyErrorCode::Uncertain)?;
        require(!self.entries.iter().any(|e| {
            e.descriptor.binding_id == descriptor.binding_id
                && !e.descriptor.same_binding(descriptor)
        }))?;
        let withheld = binding.revoked
            || now < binding.created_at
            || now >= descriptor.event_expires_at
            || (inspection.status == "terminal" && inspection.delivery_authorized != Some(true));
        let mut incoming = Entry {
            descriptor: descriptor.clone(),
            receipt: receipt.clone(),
            withheld,
        };
        if let Some(old) = self.entries.iter_mut().find(|e| {
            e.descriptor.binding_id == descriptor.binding_id
                && e.descriptor.event_id == descriptor.event_id
        }) {
            require(
                old.descriptor == *descriptor
                    && old.receipt.admission_id == receipt.admission_id
                    && old.receipt.sequence == receipt.sequence
                    && old.receipt.authority_epoch == receipt.authority_epoch
                    && old.receipt.execution_generation == receipt.execution_generation,
            )?;
            if old.receipt.status == "terminal" {
                require(receipt.status == "terminal" && old.receipt.outcome == receipt.outcome)?;
                if !old.withheld && !withheld {
                    require(old.receipt.result == receipt.result)?;
                }
            }
            incoming.withheld |= old.withheld;
            if incoming.withheld {
                incoming.receipt.result = None;
            }
            *old = incoming;
        } else {
            if self.entries.len() == 16 {
                return Err(IvyErrorCode::Uncertain);
            }
            require(!self.entries.iter().any(|e| {
                e.receipt.admission_id == receipt.admission_id
                    || e.receipt.sequence == receipt.sequence
            }))?;
            if incoming.withheld {
                incoming.receipt.result = None;
            }
            self.entries.push(incoming);
        }
        if self.cursor.as_ref().is_none_or(|(_, last)| seq > *last) {
            self.cursor = Some((epoch.into(), seq));
        }
        Ok(())
    }

    pub fn save(&self, path: &Path) -> Result<(), IvyErrorCode> {
        self.validate(&self.session)?;
        let bytes = serde_json::to_vec(self).map_err(|_| IvyErrorCode::Storage)?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(IvyErrorCode::Storage);
        }
        let temporary = path.with_extension("pending");
        let mut f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|_| IvyErrorCode::Storage)?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| IvyErrorCode::Storage)?;
        fs::rename(temporary, path).map_err(|_| IvyErrorCode::Storage)
    }
}
