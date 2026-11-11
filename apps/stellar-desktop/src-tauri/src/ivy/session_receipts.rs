use super::{contracts::*, session::Session};
use serde_json::{Value, json};

impl Session {
    pub(super) fn accept_receipt(&mut self, value: &Value) -> Result<(), IvyErrorCode> {
        if value.pointer("/ref/session_id").and_then(Value::as_str)
            != self.record.session_id.as_deref()
        {
            return Err(IvyErrorCode::Protocol);
        }
        let admission = super::session::bounded_id(value.get("admission_id"))?;
        let generation = value.get("execution_generation").and_then(Value::as_u64);
        if self
            .record
            .admission_id
            .as_ref()
            .is_some_and(|known| known != &admission)
            || self
                .record
                .generation
                .is_some_and(|known| Some(known) != generation)
        {
            return Err(IvyErrorCode::Uncertain);
        }
        self.record.admission_id = Some(admission);
        self.record.generation = generation;
        self.journal.save(&self.record)
    }

    pub fn reconcile(&mut self) -> Result<(), IvyErrorCode> {
        if self.record.pending_reset.is_some() {
            return self.new_session();
        }
        let Some(sid) = self.record.session_id.clone() else {
            self.restore_admission_state();
            return Ok(());
        };
        let resumed = self.call("session.resume", json!({"session_id":sid}))?;
        if resumed.get("session_id").and_then(Value::as_str) != Some(&sid) {
            return Err(IvyErrorCode::Protocol);
        }
        if self.record.admission_id.is_none() && self.record.unsettled {
            let pending = resumed
                .get("pending")
                .and_then(Value::as_array)
                .ok_or(IvyErrorCode::Uncertain)?;
            let matching: Vec<_> = pending
                .iter()
                .filter(|item| {
                    item.get("input_id").and_then(Value::as_str) == self.record.input_id.as_deref()
                })
                .collect();
            if matching.len() != 1 {
                return Err(IvyErrorCode::Uncertain);
            }
            self.accept_receipt(matching[0])?;
        }
        self.observe_receipt()
    }

    pub(super) fn observe_receipt(&mut self) -> Result<(), IvyErrorCode> {
        if !self.record.unsettled {
            return self.drain();
        }
        let Some(sid) = self.record.session_id.clone() else {
            return Err(IvyErrorCode::Uncertain);
        };
        let Some(admission) = self.record.admission_id.clone() else {
            return Err(IvyErrorCode::Uncertain);
        };
        let receipt = self.call(
            "prompt.receipt",
            json!({"session_id":sid,"admission_id":admission,"include_result":true}),
        )?;
        if receipt.get("admission_id").and_then(Value::as_str) != Some(&admission) {
            return Err(IvyErrorCode::Protocol);
        }
        if receipt.get("status").and_then(Value::as_str) == Some("terminal")
            && receipt.get("outcome").and_then(Value::as_str) == Some("completed")
            && receipt
                .pointer("/result/final_response")
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(IvyErrorCode::Protocol);
        }
        self.accept_receipt(&receipt)?;
        if receipt.get("status").and_then(Value::as_str) == Some("terminal") {
            let outcome = receipt
                .get("outcome")
                .and_then(Value::as_str)
                .ok_or(IvyErrorCode::Protocol)?;
            let text = receipt
                .pointer("/result/final_response")
                .and_then(Value::as_str)
                .unwrap_or("");
            self.complete_with_reuse(
                outcome,
                text,
                receipt
                    .pointer("/result/response_reused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )?;
        }
        self.drain()
    }
}
