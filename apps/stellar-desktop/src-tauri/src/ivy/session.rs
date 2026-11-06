use super::{
    contracts::*,
    journal::{Journal, Record, WorkspaceDescriptor},
    process::Broker,
    state::Shared,
};
use serde_json::{Value, json};

pub struct Session {
    pub journal: Journal,
    pub record: Record,
    pub broker: Option<Broker>,
    pub shared: Shared,
    pub epoch: u64,
    pub workspace_epoch: u64,
    pub buffered: Vec<Value>,
    pub replay: Option<(String, u64)>,
}

impl Session {
    pub fn restore_admission_state(&self) {
        self.shared.update(self.epoch, |view| {
            if self.record.unsettled || self.record.pending_reset.is_some() {
                view.turn = IvyTurnState::Uncertain;
            } else if matches!(
                view.turn,
                IvyTurnState::Submitting | IvyTurnState::Admitted | IvyTurnState::Uncertain
            ) || view.turn_id != self.record.input_id
            {
                view.turn = IvyTurnState::Idle;
                view.items.clear();
                view.activity.clear();
            }
            view.turn_id = self.record.input_id.clone();
        });
    }
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, IvyErrorCode> {
        if !self.shared.current(self.epoch) {
            return Err(IvyErrorCode::Unavailable);
        }
        self.broker.as_mut().ok_or(IvyErrorCode::Unavailable)?.call(
            method,
            params,
            &mut self.buffered,
        )
    }

    pub fn submit(&mut self, request: IvySubmitRequest) -> Result<(), IvyErrorCode> {
        if self.record.input_id.as_deref() == Some(&request.input_id) {
            return Ok(());
        }
        if self.record.unsettled || self.record.pending_reset.is_some() {
            return Err(IvyErrorCode::Uncertain);
        }
        let sid = self.ensure_session(&request.input_id)?;
        let text = super::workspace_context::prompt(request.text, self.record.workspace.is_some());
        let params = json!({"session_id":sid,"input_id":request.input_id,"text":text,"workspace_epoch":self.workspace_epoch.to_string()});
        super::process::request_line(u64::MAX, "prompt.submit", &params)?;
        let previous = self.record.clone();
        let next = Record {
            session_id: Some(sid.clone()),
            input_id: Some(request.input_id.clone()),
            admission_id: None,
            generation: None,
            unsettled: true,
            model: self.record.model,
            route_verified: true,
            workspace: self.record.workspace.clone(),
            pending_reset: None,
        };
        self.journal.save(&next)?;
        self.record = next;
        self.replay = None;
        if !self.shared.current(self.epoch) {
            self.record = previous;
            self.journal.save(&self.record)?;
            return Err(IvyErrorCode::Unavailable);
        }
        let receipt = self
            .broker
            .as_mut()
            .ok_or(IvyErrorCode::Unavailable)?
            .call("prompt.submit", params, &mut self.buffered)?;
        self.accept_receipt(&receipt)?;
        self.shared.update(self.epoch, |snapshot| {
            snapshot.verified_model = self.record.route_verified.then_some(self.record.model);
            snapshot.turn = IvyTurnState::Admitted;
            snapshot.turn_id = self.record.input_id.clone();
            snapshot.error = None;
            snapshot.activity.clear();
        });
        self.drain()
    }

    pub(super) fn ensure_session(&mut self, request_id: &str) -> Result<String, IvyErrorCode> {
        if self.record.session_id.is_none() && self.record.workspace.is_none() {
            let created = self.call(
                "workspace.setup",
                json!({"descriptor":null, "session_id":null}),
            )?;
            let descriptor: WorkspaceDescriptor = self
                .broker
                .as_ref()
                .ok_or(IvyErrorCode::Unavailable)?
                .configure_workspace(created)?;
            if descriptor.port == 0
                || descriptor.credential_ref.len() != 32
                || !descriptor
                    .credential_ref
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(IvyErrorCode::Protocol);
            }
            let mut next = self.record.clone();
            next.workspace = Some(descriptor);
            self.journal.save(&next)?;
            self.record = next;
        }
        let sid = if let Some(sid) = self.record.session_id.clone() {
            let resumed = self.call("session.resume", json!({"session_id":sid}))?;
            if resumed.get("session_id").and_then(Value::as_str) != Some(&sid) {
                return Err(IvyErrorCode::Protocol);
            }
            if resumed.get("model").and_then(Value::as_str) != Some(model_route(self.record.model))
            {
                return Err(IvyErrorCode::Unavailable);
            }
            sid
        } else {
            let created = self.call(
                "session.create",
                json!({"request_id":request_id, "model": model_route(self.record.model)}),
            )?;
            let sid = bounded_id(created.get("session_id"))?;
            if created.get("model").and_then(Value::as_str) != Some(model_route(self.record.model))
            {
                #[cfg(feature = "native-smoke")]
                if std::env::var_os("STELLAR_BACKGROUND_SMOKE").is_some() {
                    println!("STELLAR_SMOKE_STAGE bg-create-model-mismatch");
                }
                return Err(IvyErrorCode::Unavailable);
            }
            sid
        };
        Ok(sid)
    }

    fn accept_receipt(&mut self, value: &Value) -> Result<(), IvyErrorCode> {
        if value.pointer("/ref/session_id").and_then(Value::as_str)
            != self.record.session_id.as_deref()
        {
            return Err(IvyErrorCode::Protocol);
        }
        let admission = bounded_id(value.get("admission_id"))?;
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

    pub fn rotate(&mut self, model: IvyModel, force: bool) -> Result<(), IvyErrorCode> {
        if self.record.unsettled || self.record.pending_reset.is_some() {
            return Err(IvyErrorCode::Uncertain);
        }
        if !force && self.record.model == model {
            return Ok(());
        }
        if !force && self.record.session_id.is_some() && self.record.workspace.is_none() {
            return Err(IvyErrorCode::Unavailable);
        }
        let had_workspace = self.record.workspace.is_some();
        let next = Record {
            model,
            ..Record::default()
        };
        self.journal.save(&next)?;
        self.record = next;
        self.buffered.clear();
        self.replay = None;
        self.shared.update_current(|view| {
            view.model = model;
            view.background_updates = None;
            view.reset_id = None;
            view.verified_model = None;
            view.workspace_tools = WorkspaceToolsState::Unavailable;
            view.turn = IvyTurnState::Idle;
            view.turn_id = None;
            view.items.clear();
            view.activity.clear();
            view.error = None;
        });
        if had_workspace && self.broker.is_some() {
            self.call("workspace.stop", json!({}))?;
        }
        Ok(())
    }
    pub fn cancel(&mut self) -> Result<(), IvyErrorCode> {
        if !self.record.unsettled {
            return Ok(());
        }
        self.reconcile()?;
        if !self.record.unsettled {
            return Ok(());
        }
        let generation = self.record.generation.ok_or(IvyErrorCode::Uncertain)?;
        self.call(
            "session.interrupt",
            json!({"session_id":self.record.session_id,"execution_generation":generation}),
        )?;
        self.drain()
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
            self.complete(outcome, text)?;
        }
        self.drain()
    }

    pub fn drain(&mut self) -> Result<(), IvyErrorCode> {
        for event in std::mem::take(&mut self.buffered) {
            self.event(event)?;
        }
        Ok(())
    }
}

pub(super) fn bounded_id(value: Option<&Value>) -> Result<String, IvyErrorCode> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .map(str::to_owned)
        .ok_or(IvyErrorCode::Protocol)
}

fn model_route(model: IvyModel) -> &'static str {
    match model {
        IvyModel::Terra => "gpt-6.1-terra",
        IvyModel::Sol => "gpt-6.1-sol",
    }
}
