use super::{contracts::*, journal::PendingReset, session::Session};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy)]
pub enum Control {
    NewSession,
    ReloadMcp,
}

impl Session {
    pub(super) fn control(&mut self, control: Control) -> Result<IvySnapshot, IvyErrorCode> {
        let result = match control {
            Control::NewSession => self.new_session(),
            Control::ReloadMcp => self.reload_mcp(),
        };
        if result.is_err() && self.record.pending_reset.is_some() {
            self.shared.update(self.epoch, |view| {
                view.turn = IvyTurnState::Uncertain;
                view.activity.clear();
                view.error = Some(IvyErrorCode::Uncertain);
            });
        }
        result?;
        self.shared
            .view
            .lock()
            .map(|view| view.snapshot.clone())
            .map_err(|_| IvyErrorCode::Unavailable)
    }

    fn reload_mcp(&mut self) -> Result<(), IvyErrorCode> {
        if self.record.unsettled || self.record.pending_reset.is_some() {
            return Err(IvyErrorCode::Busy);
        }
        if let Some(sid) = self.record.session_id.clone() {
            self.call("session.resume", json!({"session_id":sid}))?;
        }
        let reply = self.call(
            "integrations.reload",
            json!({"session_id": self.record.session_id}),
        )?;
        if reply.get("status").and_then(Value::as_str) != Some("reloaded") {
            return Err(IvyErrorCode::Unavailable);
        }
        Ok(())
    }

    pub(super) fn new_session(&mut self) -> Result<(), IvyErrorCode> {
        if self.record.unsettled {
            return Err(IvyErrorCode::Busy);
        }
        if let Some(pending) = &self.record.pending_reset {
            let request_id = pending.request_id.clone();
            // A reconnected bridge must reattach the logical session before retrying its receipt.
            self.ensure_session(&request_id)?;
        } else {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| IvyErrorCode::Unavailable)?
                .as_nanos();
            let request_id = format!("stellar-new-{nonce}");
            let sid = self.ensure_session(&request_id)?;
            let before = self.call("session.resume", json!({"session_id": sid}))?;
            if before.get("running").and_then(Value::as_bool) != Some(false)
                || before
                    .get("pending")
                    .and_then(Value::as_array)
                    .is_none_or(|rows| !rows.is_empty())
            {
                return Err(IvyErrorCode::Busy);
            }
            let pending = PendingReset {
                request_id,
                revision: before
                    .get("revision")
                    .and_then(Value::as_u64)
                    .ok_or(IvyErrorCode::Protocol)?,
                generation: before
                    .get("execution_generation")
                    .and_then(Value::as_u64)
                    .ok_or(IvyErrorCode::Protocol)?,
            };
            let mut record = self.record.clone();
            record.session_id = Some(sid);
            record.pending_reset = Some(pending);
            self.journal.save(&record)?;
            self.record = record;
        }
        let pending = self
            .record
            .pending_reset
            .clone()
            .ok_or(IvyErrorCode::Protocol)?;
        let reply = self.call(
            "session.new",
            json!({
                "session_id":self.record.session_id, "request_id":pending.request_id,
                "revision":pending.revision, "generation":pending.generation,
            }),
        )?;
        if reply.get("status").and_then(Value::as_str) != Some("fresh")
            || reply
                .get("execution_generation")
                .and_then(Value::as_u64)
                .is_none_or(|v| v <= pending.generation)
        {
            return Err(IvyErrorCode::Uncertain);
        }
        let mut record = self.record.clone();
        record.input_id = None;
        record.admission_id = None;
        record.generation = None;
        record.pending_reset = None;
        self.journal.save(&record)?;
        self.record = record;
        self.buffered.clear();
        self.replay = None;
        self.shared.update(self.epoch, |view| {
            view.reset_id = Some(pending.request_id);
            view.turn_id = None;
            view.turn = IvyTurnState::Idle;
            view.items.clear();
            view.response_segments.clear();
            view.activity.clear();
            view.error = None;
        });
        Ok(())
    }
}
