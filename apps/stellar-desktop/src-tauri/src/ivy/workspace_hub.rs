use super::{
    contracts::{IvyErrorCode, IvyTurnState, WorkspaceToolsState},
    process::{self, SharedInput},
    state::Shared,
    workspace_contracts::{
        WorkspaceToolOperation, WorkspaceToolOutcome, WorkspaceToolReply, WorkspaceToolRequest,
    },
    workspace_data::{self, SharedImageEndpoint},
    workspace_validate,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub type Publisher = Arc<dyn Fn(WorkspaceToolRequest) -> bool + Send + Sync>;
pub type Capture = Arc<dyn Fn() -> Result<Vec<u8>, IvyErrorCode> + Send + Sync>;
struct Pending {
    request: WorkspaceToolRequest,
    started: Instant,
}

pub struct WorkspaceHub {
    shared: Shared,
    input: Mutex<Option<SharedInput>>,
    publisher: Mutex<Option<Publisher>>,
    capture: Mutex<Option<Capture>>,
    pending: Mutex<Option<Pending>>,
    image_endpoint: SharedImageEndpoint,
}

impl WorkspaceHub {
    pub fn new(shared: Shared) -> Self {
        Self {
            shared,
            input: Mutex::new(None),
            publisher: Mutex::new(None),
            capture: Mutex::new(None),
            pending: Mutex::new(None),
            image_endpoint: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_input(&self, input: Option<SharedInput>) {
        if input.is_none()
            && let Ok(mut endpoint) = self.image_endpoint.lock()
        {
            *endpoint = None;
        }
        if let Ok(mut current) = self.input.lock() {
            *current = input;
        }
    }

    pub fn image_endpoint(&self) -> SharedImageEndpoint {
        self.image_endpoint.clone()
    }

    pub fn set_publisher(&self, publisher: Publisher) {
        if let Ok(mut current) = self.publisher.lock() {
            *current = Some(publisher);
        }
    }

    pub fn set_capture(&self, capture: Capture) {
        if let Ok(mut current) = self.capture.lock() {
            *current = Some(capture);
        }
    }

    pub fn disarm(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
        if let Ok(input) = self.input.lock()
            && let Some(input) = input.as_ref()
        {
            let _ = process::control(input, &json!({"control":"workspace_disarm"}));
        }
    }

    pub fn handle(self: &Arc<Self>, frame: Value) -> Result<(), IvyErrorCode> {
        let started = Instant::now();
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| IvyErrorCode::Unavailable)?
            .as_millis()
            .checked_add(15_000)
            .ok_or(IvyErrorCode::Unavailable)?;
        let mut data = frame.get("data").cloned().ok_or(IvyErrorCode::Protocol)?;
        let object = data.as_object_mut().ok_or(IvyErrorCode::Protocol)?;
        if object
            .insert("expires_at_ms".into(), deadline.to_string().into())
            .is_some()
        {
            return Err(IvyErrorCode::Protocol);
        }
        let request: WorkspaceToolRequest =
            serde_json::from_value(data).map_err(|_| IvyErrorCode::Protocol)?;
        if !workspace_validate::request(&request) {
            return Err(IvyErrorCode::Protocol);
        }
        let current = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if request.epoch != current.snapshot.workspace_epoch
            || current.snapshot.turn_id.as_deref() != Some(&request.turn_id)
            || !matches!(
                current.snapshot.turn,
                IvyTurnState::Submitting | IvyTurnState::Admitted
            )
        {
            drop(current);
            let reply = WorkspaceToolReply {
                version: 1,
                request_id: request.request_id,
                epoch: request.epoch,
                turn_id: request.turn_id,
                outcome: WorkspaceToolOutcome::Rejected,
            };
            let _ = self.send(&json!({"control":"workspace_reply","reply":reply}));
            return Ok(());
        }
        let connection_epoch = current.epoch;
        drop(current);
        let mut pending = self.pending.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        if pending
            .as_ref()
            .is_some_and(|entry| entry.started.elapsed() < Duration::from_secs(19))
        {
            return Err(IvyErrorCode::Busy);
        }
        *pending = Some(Pending {
            request: request.clone(),
            started,
        });
        drop(pending);
        self.shared.update(connection_epoch, |view| {
            view.workspace_tools = WorkspaceToolsState::Available
        });
        if matches!(request.operation, WorkspaceToolOperation::CaptureWindow) {
            let capture = self
                .capture
                .lock()
                .map_err(|_| IvyErrorCode::Unavailable)?
                .clone();
            if let Some(capture) = capture {
                let hub = self.clone();
                std::thread::spawn(move || {
                    let result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| capture()))
                            .unwrap_or(Err(IvyErrorCode::Unavailable));
                    let _ = hub.finish_capture(&request, result);
                });
            } else {
                self.reject_capture(&request)?;
            }
        } else {
            let sent = self
                .publisher
                .lock()
                .map_err(|_| IvyErrorCode::Unavailable)?
                .as_ref()
                .is_some_and(|publish| publish(request.clone()));
            if !sent {
                self.reply(WorkspaceToolReply {
                    version: 1,
                    request_id: request.request_id,
                    epoch: request.epoch,
                    turn_id: request.turn_id,
                    outcome: WorkspaceToolOutcome::Rejected,
                })?;
            }
        }
        Ok(())
    }

    fn reject_capture(&self, request: &WorkspaceToolRequest) -> Result<(), IvyErrorCode> {
        let header = json!({"version":1,"request_id":request.request_id,"epoch":request.epoch,"turn_id":request.turn_id});
        self.send(&json!({"control":"workspace_capture_failed","header":header}))?;
        *self.pending.lock().map_err(|_| IvyErrorCode::Unavailable)? = None;
        Ok(())
    }

    fn finish_capture(
        &self,
        request: &WorkspaceToolRequest,
        result: Result<Vec<u8>, IvyErrorCode>,
    ) -> Result<(), IvyErrorCode> {
        let mut pending = self.pending.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let entry = pending.as_ref().ok_or(IvyErrorCode::Unavailable)?;
        if entry.started.elapsed() >= Duration::from_secs(19) || entry.request != *request {
            return Err(IvyErrorCode::Unavailable);
        }
        let current = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if request.epoch != current.snapshot.workspace_epoch
            || current.snapshot.turn_id.as_deref() != Some(&request.turn_id)
            || !matches!(
                current.snapshot.turn,
                IvyTurnState::Submitting | IvyTurnState::Admitted
            )
        {
            return Err(IvyErrorCode::Unavailable);
        }
        drop(current);
        let header = json!({"version":1,"request_id":request.request_id,"epoch":request.epoch,"turn_id":request.turn_id});
        *pending = None;
        drop(pending);
        match result {
            Ok(image) => {
                if workspace_data::send(&self.image_endpoint, &header, &image).is_err() {
                    let _ =
                        self.send(&json!({"control":"workspace_capture_failed","header":header}));
                }
            }
            Err(_) => self.send(&json!({"control":"workspace_capture_failed","header":header}))?,
        }
        Ok(())
    }

    pub fn reply(&self, reply: WorkspaceToolReply) -> Result<(), IvyErrorCode> {
        let mut pending = self.pending.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let entry = pending.as_ref().ok_or(IvyErrorCode::Unavailable)?;
        if entry.started.elapsed() >= Duration::from_secs(19)
            || !workspace_validate::reply(&entry.request, &reply)
        {
            return Err(IvyErrorCode::MalformedRequest);
        }
        let current = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if reply.epoch != current.snapshot.workspace_epoch
            || current.snapshot.turn_id.as_deref() != Some(&reply.turn_id)
            || !matches!(
                current.snapshot.turn,
                IvyTurnState::Submitting | IvyTurnState::Admitted
            )
        {
            return Err(IvyErrorCode::Unavailable);
        }
        drop(current);
        self.send(&json!({"control":"workspace_reply","reply":reply}))?;
        *pending = None;
        Ok(())
    }

    fn send(&self, frame: &Value) -> Result<(), IvyErrorCode> {
        let input = self.input.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        process::control(input.as_ref().ok_or(IvyErrorCode::Unavailable)?, frame)
    }
}
