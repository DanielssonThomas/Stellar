use super::{contracts::*, session::Session};
use serde_json::{Value, json};

impl Session {
    pub fn event(&mut self, frame: Value) -> Result<(), IvyErrorCode> {
        self.apply_event(&frame)?;
        if frame.get("event").and_then(Value::as_str) == Some("gateway")
            && let Some(params) = frame.pointer("/data/params")
            && params.get("session_id").and_then(Value::as_str) == self.record.session_id.as_deref()
        {
            self.checkpoint_updates(params)?;
        }
        Ok(())
    }
    fn apply_event(&mut self, frame: &Value) -> Result<(), IvyErrorCode> {
        if frame.get("event").and_then(Value::as_str) != Some("gateway") {
            return Ok(());
        }
        let Some(params) = frame.pointer("/data/params") else {
            return Err(IvyErrorCode::Protocol);
        };
        if params.get("session_id").and_then(Value::as_str) != self.record.session_id.as_deref() {
            return Ok(());
        }
        if params.get("type").and_then(Value::as_str) == Some("session.replay_gap") {
            return Err(IvyErrorCode::Uncertain);
        }
        self.validate_update_event(params)?;
        self.lifecycle_fence(params)?;
        if self.lifecycle_event(params)? {
            return Ok(());
        }
        if self.background_event(params)? {
            return Ok(());
        }
        let admission = params
            .get("admission_id")
            .or_else(|| params.pointer("/payload/admission_id"))
            .and_then(Value::as_str);
        if admission.is_none() || admission != self.record.admission_id.as_deref() {
            return Ok(());
        }
        let epoch = super::session::bounded_id(params.get("replay_epoch"))?;
        let sequence = params
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or(IvyErrorCode::Protocol)?;
        if let Some((previous_epoch, previous_sequence)) = &self.replay {
            if previous_epoch != &epoch {
                return Err(IvyErrorCode::Uncertain);
            }
            if sequence <= *previous_sequence {
                return Ok(());
            }
        }
        self.replay = Some((epoch.clone(), sequence));
        let generation = params
            .get("execution_generation")
            .and_then(Value::as_u64)
            .ok_or(IvyErrorCode::Protocol)?;
        if self
            .record
            .generation
            .is_some_and(|value| value != generation)
        {
            return Err(IvyErrorCode::Uncertain);
        }
        self.record.generation = Some(generation);
        if !self.record.unsettled {
            return Ok(());
        }
        match params.get("type").and_then(Value::as_str) {
            Some("stellar.first_text") => {
                if params.get("payload") != Some(&json!({"available":true})) {
                    return Err(IvyErrorCode::Protocol);
                }
                self.shared
                    .update(self.epoch, |view| view.first_text_observed = Some(true));
                Ok(())
            }
            Some("message.interim") => {
                let Some(text) = params.pointer("/payload/text").and_then(Value::as_str) else {
                    return Ok(());
                };
                if params
                    .pointer("/payload/already_streamed")
                    .and_then(Value::as_bool)
                    .is_none()
                {
                    return Ok(());
                }
                if let Some(row) = super::response_segments::segment(
                    self.record.session_id.as_deref().unwrap_or_default(),
                    admission.unwrap_or_default(),
                    generation,
                    Some((&epoch, sequence)),
                    text,
                    false,
                ) {
                    self.shared.update(self.epoch, |view| {
                        super::response_segments::append(&mut view.response_segments, row)
                    });
                }
                Ok(())
            }
            Some("stellar.activity") => self.activity(params),
            Some("clarify.request" | "clarify.settled") => self.question_event(params),
            Some("message.complete") => self.complete_with_reuse(
                params
                    .pointer("/payload/outcome")
                    .and_then(Value::as_str)
                    .ok_or(IvyErrorCode::Protocol)?,
                params
                    .pointer("/payload/text")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                params
                    .pointer("/payload/response_reused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
            Some("approval.request") => {
                self.shared.update(self.epoch, |view| {
                    view.error = Some(IvyErrorCode::ApprovalRequired)
                });
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
