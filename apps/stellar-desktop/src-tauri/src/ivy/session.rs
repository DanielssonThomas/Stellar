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
                view.response_segments.clear();
                view.activity.clear();
            }
            view.turn_id = self.record.input_id.clone();
        });
    }
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, IvyErrorCode> {
        if !self.shared.current(self.epoch) {
            return Err(IvyErrorCode::Unavailable);
        }
        let result = self
            .broker
            .as_mut()
            .ok_or(IvyErrorCode::Unavailable)?
            .call(method, params, &mut self.buffered)?;
        super::lifecycle_consumer::checked_response(method, result)
    }

    #[cfg(test)]
    pub fn submit(&mut self, request: IvySubmitRequest) -> Result<(), IvyErrorCode> {
        self.submit_with_context(request, None, None)
    }

    pub fn submit_with_context(
        &mut self,
        request: IvySubmitRequest,
        context: Option<super::workspace_context::ContextLease>,
        expression: Option<crate::speech::VoiceExpressionPending>,
    ) -> Result<(), IvyErrorCode> {
        if self.record.input_id.as_deref() == Some(&request.input_id) {
            return Ok(());
        }
        if self.record.unsettled || self.record.pending_reset.is_some() {
            return Err(IvyErrorCode::Uncertain);
        }
        let sid = self.ensure_session(&request.input_id)?;
        let mut params = json!({"session_id":sid,"input_id":request.input_id,"text":request.text,"workspace_epoch":self.workspace_epoch.to_string()});
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
        let observation = context.and_then(|resolve| resolve());
        let ivy_state = self.shared.view.lock().ok().map(|view| {
            json!({
                "model":view.snapshot.model, "turn":view.snapshot.turn,
                "workspace_tools":view.snapshot.workspace_tools,
                "pending_questions":view.snapshot.questions.as_ref().map_or(0, Vec::len),
            })
        });
        super::workspace_context::annotate_params(
            &mut params,
            observation.as_deref(),
            ivy_state,
            request.local_actions.as_deref(),
        );
        let checking_expression = expression.is_some();
        if let Some(expression) =
            expression.and_then(crate::speech::VoiceExpressionPending::resolve)
        {
            params["voice_expression"] = json!(expression);
            if super::process::request_line(u64::MAX, "prompt.submit", &params).is_err()
                && let Some(params) = params.as_object_mut()
            {
                params.remove("voice_expression");
            }
        }
        if !self.shared.current(self.epoch) {
            self.record = previous;
            self.journal.save(&self.record)?;
            return Err(IvyErrorCode::Unavailable);
        }
        if checking_expression
            && self
                .shared
                .view
                .lock()
                .is_ok_and(|view| view.snapshot.workspace_epoch != self.workspace_epoch.to_string())
        {
            self.record = previous;
            self.journal.save(&self.record)?;
            self.shared.update(self.epoch, |snapshot| {
                snapshot.turn = IvyTurnState::Cancelled;
            });
            return Ok(());
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
            snapshot.response_segments.clear();
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
            view.response_segments.clear();
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

    pub fn drain(&mut self) -> Result<(), IvyErrorCode> {
        let mut remaining = 1024usize;
        while !self.buffered.is_empty() {
            remaining = remaining
                .checked_sub(self.buffered.len())
                .ok_or(IvyErrorCode::Uncertain)?;
            for event in std::mem::take(&mut self.buffered) {
                self.event(event)?;
            }
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
