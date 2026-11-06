use super::{
    contracts::*,
    session::{Session, bounded_id},
};
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
        let epoch = bounded_id(params.get("replay_epoch"))?;
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
        self.replay = Some((epoch, sequence));
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
            Some("stellar.activity") => self.activity(params),
            Some("clarify.request" | "clarify.settled") => self.question_event(params),
            Some("message.complete") => self.complete(
                params
                    .pointer("/payload/outcome")
                    .and_then(Value::as_str)
                    .ok_or(IvyErrorCode::Protocol)?,
                params
                    .pointer("/payload/text")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
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

    pub(super) fn complete(&mut self, outcome: &str, text: &str) -> Result<(), IvyErrorCode> {
        let turn = match outcome {
            "completed" => IvyTurnState::Completed,
            "failed" => IvyTurnState::Failed,
            "cancelled" | "interrupted" => IvyTurnState::Cancelled,
            _ => return Err(IvyErrorCode::Uncertain),
        };
        let failed = turn == IvyTurnState::Failed;
        let items = if failed {
            vec![]
        } else {
            super::presentation_decode::parse_presentation(text)
        };
        self.record.unsettled = false;
        self.journal.save(&self.record)?;
        self.shared.update(self.epoch, |view| {
            view.activity.clear();
            view.turn = turn;
            view.questions = None;
            view.turn_id = self.record.input_id.clone();
            view.items = items;
            view.error = if failed {
                Some(IvyErrorCode::TurnFailed)
            } else {
                None
            };
        });
        Ok(())
    }
}
