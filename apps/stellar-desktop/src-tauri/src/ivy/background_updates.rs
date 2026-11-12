use super::{
    contracts::*,
    session::Session,
    update_store::{Admission, MAX_TEXT, Updates},
};
use serde_json::{Value, json};

fn number(value: Option<&Value>) -> Result<u64, IvyErrorCode> {
    value.and_then(Value::as_u64).ok_or(IvyErrorCode::Protocol)
}

fn identity(params: &Value) -> Result<Admission, IvyErrorCode> {
    let id = params
        .get("admission_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 512)
        .ok_or(IvyErrorCode::Protocol)?;
    Ok(Admission {
        id: id.into(),
        generation: number(params.get("execution_generation"))?,
        authority: number(params.get("authority_epoch"))?,
        sequence: 0,
    })
}

fn verified(receipt: &Value, session: &str, admission: &Admission) -> Result<(), IvyErrorCode> {
    if receipt.pointer("/ref/session_id").and_then(Value::as_str) != Some(session)
        || receipt.get("admission_id").and_then(Value::as_str) != Some(&admission.id)
        || number(receipt.get("execution_generation"))? != admission.generation
        || number(receipt.get("authority_epoch"))? != admission.authority
    {
        return Err(IvyErrorCode::Protocol);
    }
    Ok(())
}

impl Session {
    pub(super) fn validate_update_event(&self, params: &Value) -> Result<(), IvyErrorCode> {
        let sid = self
            .record
            .session_id
            .as_deref()
            .ok_or(IvyErrorCode::Protocol)?;
        let updates = Updates::load(&self.journal.updates_path(), sid)?;
        let epoch = super::session::bounded_id(params.get("replay_epoch"))?;
        number(params.get("seq"))?;
        if let Some((previous, _)) = updates.cursor
            && previous != epoch
        {
            return Err(IvyErrorCode::Uncertain);
        }
        Ok(())
    }

    pub(super) fn background_event(&mut self, params: &Value) -> Result<bool, IvyErrorCode> {
        if params.get("type").and_then(Value::as_str) == Some("message.start")
            && !params
                .get("payload")
                .and_then(Value::as_object)
                .is_some_and(|payload| {
                    payload.len() == 1
                        && payload.get("autonomous").and_then(Value::as_bool).is_some()
                })
        {
            return Err(IvyErrorCode::Protocol);
        }
        if params.get("admission_id").and_then(Value::as_str) == self.record.admission_id.as_deref()
        {
            return Ok(false);
        }
        let kind = params.get("type").and_then(Value::as_str);
        if !matches!(kind, Some("message.start" | "message.complete"))
            || (kind == Some("message.start")
                && params.pointer("/payload/autonomous") != Some(&Value::Bool(true)))
        {
            return Ok(false);
        }
        let sid = self
            .record
            .session_id
            .clone()
            .ok_or(IvyErrorCode::Protocol)?;
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, &sid)?;
        if kind == Some("message.start")
            && params.pointer("/payload/autonomous") == Some(&Value::Bool(true))
        {
            let mut admission = identity(params)?;
            let receipt = self.call(
                "prompt.receipt",
                json!({"session_id":sid,"admission_id":admission.id,"include_result":true}),
            )?;
            verified(&receipt, &sid, &admission)?;
            admission.sequence = number(receipt.get("sequence"))?;
            updates.admit(admission)?;
        } else if kind != Some("message.complete")
            || !updates
                .pending
                .iter()
                .any(|a| Some(a.id.as_str()) == params.get("admission_id").and_then(Value::as_str))
        {
            return Ok(false);
        }
        let epoch = params
            .get("replay_epoch")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty() && v.len() <= 512)
            .ok_or(IvyErrorCode::Protocol)?;
        let sequence = number(params.get("seq"))?;
        if updates
            .cursor
            .as_ref()
            .is_none_or(|(previous, last)| previous == epoch && sequence > *last)
        {
            updates.cursor = Some((epoch.into(), sequence));
        }
        updates.save(&path)?;
        self.poll_updates()?;
        Ok(true)
    }

    pub(super) fn poll_updates(&mut self) -> Result<(), IvyErrorCode> {
        let Some(sid) = self.record.session_id.clone() else {
            return Ok(());
        };
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, &sid)?;
        while let Some(admission) = updates.pending.first().cloned() {
            let receipt = self.call(
                "prompt.receipt",
                json!({"session_id":sid,"admission_id":admission.id,"include_result":true}),
            )?;
            verified(&receipt, &sid, &admission)?;
            if number(receipt.get("sequence"))? != admission.sequence {
                return Err(IvyErrorCode::Protocol);
            }
            match receipt.get("status").and_then(Value::as_str) {
                Some("terminal") => {}
                Some("queued" | "started") => break,
                Some("unknown") => return Err(IvyErrorCode::Uncertain),
                _ => return Err(IvyErrorCode::Protocol),
            }
            if receipt.get("outcome").and_then(Value::as_str) == Some("completed") {
                let raw = receipt
                    .pointer("/result/final_response")
                    .and_then(Value::as_str)
                    .ok_or(IvyErrorCode::Protocol)?;
                let text = super::presentation_decode::parse_presentation(raw)
                    .into_iter()
                    .find_map(|item| match item {
                        super::presentation::IvyPresentation::Text { text } => Some(text),
                        _ => None,
                    })
                    .unwrap_or_default();
                if text.len() > MAX_TEXT {
                    return Err(IvyErrorCode::Uncertain);
                }
                if !text.trim().is_empty() {
                    if updates.completed.len() == 8 {
                        if updates.completed[0].speech_claim.is_none() {
                            break;
                        }
                        updates.completed.remove(0);
                    }
                    updates.completed.push(IvyBackgroundUpdate {
                        id: admission.id.clone(),
                        text,
                        speech_claim: None,
                    });
                }
            } else if !matches!(
                receipt.get("outcome").and_then(Value::as_str),
                Some("failed" | "cancelled" | "interrupted")
            ) {
                return Err(IvyErrorCode::Uncertain);
            }
            updates.settled_sequence = admission.sequence;
            updates.pending.remove(0);
            updates.save(&path)?;
        }
        self.publish_updates(updates.completed);
        Ok(())
    }

    fn publish_updates(&self, updates: Vec<IvyBackgroundUpdate>) {
        let updates = (!updates.is_empty()).then_some(updates);
        if self
            .shared
            .view
            .lock()
            .is_ok_and(|v| v.snapshot.background_updates == updates)
        {
            return;
        }
        self.shared
            .update(self.epoch, |view| view.background_updates = updates);
    }

    pub(super) fn claim_update(
        &mut self,
        request: IvyClaimUpdateRequest,
    ) -> Result<IvySnapshot, IvyErrorCode> {
        let sid = self
            .record
            .session_id
            .clone()
            .ok_or(IvyErrorCode::Unavailable)?;
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, &sid)?;
        let update = updates
            .completed
            .iter_mut()
            .find(|u| u.id == request.update_id)
            .ok_or(IvyErrorCode::Unavailable)?;
        if update.speech_claim.is_none() {
            update.speech_claim = Some(request.request_id);
            updates.save(&path)?;
        }
        self.publish_updates(updates.completed);
        self.shared
            .view
            .lock()
            .map(|v| v.snapshot.clone())
            .map_err(|_| IvyErrorCode::Unavailable)
    }

    pub(super) fn resume_updates(&mut self, resumed: &Value) -> Result<(), IvyErrorCode> {
        self.poll_updates()?;
        let sid = self
            .record
            .session_id
            .clone()
            .ok_or(IvyErrorCode::Unavailable)?;
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, &sid)?;
        if let Some((epoch, sequence)) = &updates.cursor {
            let replay = self.call(
                "session.events.since",
                json!({"session_id":sid,"replay_epoch":epoch,"last_sequence":sequence}),
            )?;
            if replay.get("truncated") != Some(&Value::Bool(false))
                || replay.get("replay_epoch").and_then(Value::as_str) != Some(epoch)
                || number(replay.get("last_sequence"))? < *sequence
            {
                return Err(IvyErrorCode::Uncertain);
            }
            let events = replay
                .get("events")
                .and_then(Value::as_array)
                .filter(|v| v.len() <= 1024)
                .ok_or(IvyErrorCode::Protocol)?;
            for params in events {
                self.buffered
                    .push(json!({"event":"gateway","data":{"params":params}}));
            }
            self.buffered.sort_by_key(|event| {
                event
                    .pointer("/data/params/seq")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            });
        } else {
            let epoch = resumed
                .get("replay_epoch")
                .and_then(Value::as_str)
                .ok_or(IvyErrorCode::Protocol)?;
            updates.cursor = Some((epoch.into(), number(resumed.get("last_sequence"))?));
            updates.save(&path)?;
        }
        self.poll_updates()
    }

    pub(super) fn reset_updates(&self, generation: u64) -> Result<(), IvyErrorCode> {
        let Some(sid) = &self.record.session_id else {
            return Ok(());
        };
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, sid)?;
        updates.floor_generation = generation;
        updates.pending.clear();
        updates.completed.clear();
        updates.save(&path)?;
        self.publish_updates(vec![]);
        Ok(())
    }

    pub(super) fn checkpoint_updates(&self, params: &Value) -> Result<(), IvyErrorCode> {
        let Some(sid) = &self.record.session_id else {
            return Ok(());
        };
        let Some(epoch) = params.get("replay_epoch").and_then(Value::as_str) else {
            return Ok(());
        };
        let sequence = number(params.get("seq"))?;
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, sid)?;
        if let Some((previous, last)) = &updates.cursor {
            if previous != epoch {
                return Err(IvyErrorCode::Uncertain);
            }
            if sequence <= *last {
                return Ok(());
            }
        }
        updates.cursor = Some((epoch.into(), sequence));
        updates.save(&path)
    }
}
