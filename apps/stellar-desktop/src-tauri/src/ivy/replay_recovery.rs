#[path = "replay_recovery_tail.rs"]
mod tail;
use super::{
    contracts::IvyErrorCode,
    lifecycle_store::Staging,
    plugin_notifications::{Notice, descriptor},
    session::Session,
    update_store::{Admission, Updates},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    session_id: String,
    profile_id: String,
    physical_session_id: String,
    authority_epoch: u64,
    execution_generation: u64,
    revision: u64,
    replay_epoch: String,
    last_sequence: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    profile_id: String,
    session_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    admission_id: String,
    #[serde(rename = "ref")]
    reference: Reference,
    sequence: u64,
    status: String,
    outcome: Option<String>,
    authority_epoch: u64,
    execution_generation: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    receipt: Receipt,
    input_id: String,
    kind: String,
    descriptor: Option<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recovery {
    snapshot: Snapshot,
    entries: Vec<Entry>,
    tail: Value,
}
fn require(value: bool) -> Result<(), IvyErrorCode> {
    value.then_some(()).ok_or(IvyErrorCode::Uncertain)
}
fn bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.contains('\0')
}
impl Entry {
    fn validate(&self, snapshot: &Snapshot) -> Result<(), IvyErrorCode> {
        let r = &self.receipt;
        require(bounded(&r.admission_id) && bounded(&self.input_id) && r.sequence > 0)?;
        require(
            r.reference.session_id == snapshot.session_id
                && r.reference.profile_id == snapshot.profile_id,
        )?;
        require(r.authority_epoch > 0 && r.authority_epoch <= snapshot.authority_epoch)?;
        require(matches!(
            r.status.as_str(),
            "queued" | "started" | "unknown" | "terminal"
        ))?;
        require((r.status == "terminal") == r.outcome.is_some())?;
        require(r.outcome.as_deref().is_none_or(|v| {
            matches!(
                v,
                "completed" | "failed" | "interrupted" | "cancelled" | "rejected"
            )
        }))?;
        require(
            r.execution_generation
                .is_none_or(|v| v > 0 && v <= snapshot.execution_generation),
        )?;
        require(r.status != "queued" || r.execution_generation.is_none())?;
        require(
            !matches!(r.status.as_str(), "started" | "unknown") || r.execution_generation.is_some(),
        )?;
        require(r.outcome.as_deref() != Some("completed") || r.execution_generation.is_some())?;
        require(matches!(
            self.kind.as_str(),
            "ordinary" | "notification" | "ignored"
        ))?;
        require((self.kind == "notification") == self.descriptor.is_some())?;
        if let Some(value) = &self.descriptor {
            require(descriptor(value, &snapshot.session_id))?;
            require(
                value["binding"]["profile_id"] == snapshot.profile_id
                    && value["binding"]["session_id"] == snapshot.physical_session_id,
            )?;
        }
        Ok(())
    }
    fn admission(&self) -> Option<Admission> {
        Some(Admission {
            id: self.receipt.admission_id.clone(),
            generation: self.receipt.execution_generation?,
            authority: self.receipt.authority_epoch,
            sequence: self.receipt.sequence,
        })
    }
}

impl Session {
    pub(super) fn recover_updates(&mut self) -> Result<(), IvyErrorCode> {
        self.publish_updates(vec![]);
        self.broker
            .as_mut()
            .ok_or(IvyErrorCode::Unavailable)?
            .recovery_hold = true;
        let sid = self
            .record
            .session_id
            .clone()
            .ok_or(IvyErrorCode::Unavailable)?;
        let path = self.journal.updates_path();
        let previous = Updates::load(&path, &sid)?;
        let value = self.call("stellar.session.recover", json!({"session_id":sid,
            "after_sequence":previous.settled_sequence,"retained":previous.notices.keys().collect::<Vec<_>>()}))?;
        let recovery: Recovery =
            serde_json::from_value(value).map_err(|_| IvyErrorCode::Protocol)?;
        let s = &recovery.snapshot;
        require(
            s.session_id == sid
                && bounded(&s.profile_id)
                && bounded(&s.physical_session_id)
                && bounded(&s.replay_epoch)
                && s.authority_epoch > 0
                && s.execution_generation <= 2048,
        )?;
        require(previous.cursor.as_ref().is_none_or(|(epoch, sequence)| {
            epoch != &s.replay_epoch || s.last_sequence >= *sequence
        }))?;
        let _authenticated_revision = s.revision;
        require(recovery.entries.len() <= 2048)?;
        let staging = Staging::load(&self.lifecycle_path(&sid), &sid)?;
        let mut entries = BTreeMap::new();
        let mut last = 0;
        let mut next = previous.clone();
        for entry in &recovery.entries {
            entry.validate(s)?;
            require(
                !staging
                    .entries
                    .iter()
                    .any(|e| e.receipt.admission_id == entry.receipt.admission_id),
            )?;
            require(entry.receipt.sequence > last)?;
            last = entry.receipt.sequence;
            require(
                entries
                    .insert(entry.receipt.admission_id.as_str(), entry)
                    .is_none(),
            )?;
            if let Some(old) = next.notices.get(&entry.receipt.admission_id) {
                require(
                    entry.descriptor.as_ref() == Some(&old.descriptor)
                        && entry.admission().as_ref() == Some(&old.admission),
                )?;
                if !old.revoked {
                    match self.inspect_notice(old) {
                        Ok(_) | Err(IvyErrorCode::Unavailable) => {}
                        Err(error) => return Err(error),
                    }
                }
            } else if entry.receipt.sequence > next.settled_sequence
                && entry.kind != "ignored"
                && self.record.admission_id.as_deref() != Some(&entry.receipt.admission_id)
                && self.record.input_id.as_deref() != Some(&entry.input_id)
                && let Some(admission) = entry.admission()
            {
                if let Some(value) = &entry.descriptor {
                    require(!next.completed.iter().any(|u| u.id == admission.id))?;
                    let notice = Notice {
                        descriptor: value.clone(),
                        admission: admission.clone(),
                        revoked: false,
                    };
                    match self.inspect_notice(&notice) {
                        Ok(_) | Err(IvyErrorCode::Unavailable) => {}
                        Err(error) => return Err(error),
                    }
                    next.admit(admission.clone())?;
                    if next.pending.iter().any(|v| v.id == admission.id) {
                        next.notices.insert(admission.id.clone(), notice);
                    }
                } else {
                    // The inventory cannot distinguish an older foreground answer from an
                    // autonomous answer. Only existing ordinary custody permits recovery.
                    require(next.pending.iter().any(|v| v == &admission))?;
                    next.admit(admission)?;
                }
            }
        }
        require(
            previous
                .notices
                .keys()
                .all(|id| entries.contains_key(id.as_str())),
        )?;
        for pending in &previous.pending {
            require(
                entries
                    .get(pending.id.as_str())
                    .and_then(|e| e.admission())
                    .as_ref()
                    == Some(pending),
            )?;
        }
        require(
            recovery.tail["truncated"] == false
                && recovery.tail["replay_epoch"] == s.replay_epoch
                && recovery.tail["last_sequence"]
                    .as_u64()
                    .is_some_and(|v| v >= s.last_sequence),
        )?;
        let tail = recovery.tail["events"]
            .as_array()
            .ok_or(IvyErrorCode::Protocol)?;
        let future = tail::account(&previous, &mut next, s, &entries, &self.buffered, tail)?;
        next.recovery_pending = true;
        next.cursor = Some((s.replay_epoch.clone(), s.last_sequence));
        next.save(&path)?;
        self.buffered = future;
        self.replay = None;
        self.drain()?;
        let mut applied = Updates::load(&path, &sid)?;
        applied.recovery_pending = false;
        applied.save(&path)?;
        self.broker
            .as_mut()
            .ok_or(IvyErrorCode::Unavailable)?
            .recovery_hold = false;
        self.poll_updates()
    }
}
