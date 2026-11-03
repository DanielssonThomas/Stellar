#[cfg(test)]
use super::process::Broker;
use super::{
    contracts::*,
    journal::Journal,
    process::{self, OwnedChild},
    rotation::{self, Pending, Ticket},
    session::Session,
    state::{Publisher, Shared, View},
    workspace_contracts::WorkspaceToolReply,
    workspace_hub::{self, WorkspaceHub},
};
#[cfg(test)]
use serde_json::json;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};

#[path = "host_requests.rs"]
mod requests;
#[path = "host_startup.rs"]
mod startup;

pub enum Action {
    Connect,
    Submit(IvySubmitRequest),
    Cancel,
    Reconcile,
    Lifecycle(
        super::lifecycle::Control,
        Ticket,
        mpsc::SyncSender<Result<IvySnapshot, IvyErrorCode>>,
    ),
    Disconnect,
    Rotate(
        IvyModel,
        bool,
        Ticket,
        mpsc::SyncSender<Result<IvySnapshot, IvyErrorCode>>,
    ),
    #[cfg(feature = "native-smoke")]
    SmokeHold(mpsc::SyncSender<()>),
}
struct Work {
    epoch: u64,
    workspace_epoch: u64,
    action: Action,
}
pub struct IvyHost {
    shared: Shared,
    child: OwnedChild,
    sender: SyncSender<Work>,
    gate: Mutex<()>,
    pending_rotation: Pending,
    workspace: Arc<WorkspaceHub>,
}

pub struct RotationReply {
    rx: mpsc::Receiver<Result<IvySnapshot, IvyErrorCode>>,
    pending: Pending,
    ticket: Ticket,
    timeout: Duration,
}
impl RotationReply {
    pub fn wait(self) -> Result<IvySnapshot, IvyErrorCode> {
        rotation::wait_for(self.rx, self.pending, self.ticket, self.timeout)
    }
}

impl IvyHost {
    #[cfg(feature = "native-smoke")]
    pub fn smoke_hold(&self) -> Result<(), IvyErrorCode> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.request(Action::SmokeHold(tx))?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| IvyErrorCode::Timeout)
    }
    pub fn shutdown(&self) {
        if let Ok(mut view) = self.shared.view.lock() {
            view.epoch = view.epoch.saturating_add(1);
        }
        self.workspace.disarm();
        self.workspace.set_input(None);
        process::stop(&self.child);
    }
    pub fn new(directory: &Path, publish: Publisher) -> Self {
        let opened = Journal::open(directory);
        let directory = directory.to_path_buf();
        let mut snapshot = IvySnapshot::default();
        match &opened {
            Ok((_, record)) => {
                snapshot.turn_id = record.input_id.clone();
                snapshot.model = record.model;
                snapshot.verified_model = None;
                if record.unsettled || record.pending_reset.is_some() {
                    snapshot.turn = IvyTurnState::Uncertain;
                }
            }
            Err(error) => {
                snapshot.connection = IvyConnectionState::Unavailable;
                snapshot.error = Some(error.clone());
            }
        }
        let shared = Shared {
            view: Arc::new(Mutex::new(View { epoch: 0, snapshot })),
            publish,
        };
        let workspace = Arc::new(WorkspaceHub::new(shared.clone()));
        let tools = workspace.clone();
        let child = Arc::new(Mutex::new(None));
        let (sender, receiver) = mpsc::sync_channel::<Work>(4);
        let pending_rotation: Pending = Arc::new(Mutex::new(None));
        let rotations = pending_rotation.clone();
        let state = shared.clone();
        let owned = child.clone();
        std::thread::spawn(move || {
            let Some((journal, record, first)) =
                startup::acquire(opened, &directory, &receiver, &state, &rotations)
            else {
                return;
            };
            let mut session = Session {
                journal,
                record,
                broker: None,
                shared: state.clone(),
                epoch: 0,
                workspace_epoch: 0,
                buffered: vec![],
                replay: None,
            };
            let mut deadline: Option<Instant> = None;
            let mut first = first;
            loop {
                let incoming = first
                    .take()
                    .map(Ok)
                    .unwrap_or_else(|| receiver.recv_timeout(Duration::from_millis(25)));
                match incoming {
                    Ok(work) => {
                        if !state.current(work.epoch) {
                            if let Action::Rotate(_, _, ticket, reply)
                            | Action::Lifecycle(_, ticket, reply) = work.action
                            {
                                rotation::finish(&rotations, &ticket);
                                let _ = reply.send(Err(IvyErrorCode::Unavailable));
                            }
                            continue;
                        }
                        session.epoch = work.epoch;
                        session.workspace_epoch = work.workspace_epoch;
                        let result = match work.action {
                            Action::Connect => connect(&mut session, owned.clone(), tools.clone()),
                            Action::Submit(request) => {
                                deadline = Some(Instant::now() + Duration::from_secs(180));
                                session.submit(request)
                            }
                            Action::Cancel => session.cancel(),
                            Action::Reconcile => session.reconcile(),
                            #[cfg(feature = "native-smoke")]
                            Action::SmokeHold(ack) => {
                                let _ = ack.send(());
                                std::thread::sleep(Duration::from_secs(1));
                                Ok(())
                            }
                            Action::Rotate(model, force, ticket, reply) => {
                                if rotation::start(&ticket) {
                                    let result = session.rotate(model, force).and_then(|()| {
                                        session
                                            .shared
                                            .view
                                            .lock()
                                            .map(|view| view.snapshot.clone())
                                            .map_err(|_| IvyErrorCode::Unavailable)
                                    });
                                    rotation::finish(&rotations, &ticket);
                                    let _ = reply.send(result);
                                }
                                Ok(())
                            }
                            Action::Lifecycle(control, ticket, reply) => {
                                if rotation::start(&ticket) {
                                    let result = session.control(control);
                                    rotation::finish(&rotations, &ticket);
                                    let _ = reply.send(result);
                                }
                                Ok(())
                            }
                            Action::Disconnect => {
                                session.broker = None;
                                session.restore_admission_state();
                                Ok(())
                            }
                        };
                        if let Err(error) = result {
                            tools.disarm();
                            tools.set_input(None);
                            fail(&mut session, error);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if !state.current(session.epoch) {
                    session.broker = None;
                    continue;
                }
                if let Some(broker) = &session.broker {
                    match broker.poll() {
                        Ok(Some(frame)) => {
                            if let Err(error) = session.event(frame) {
                                tools.disarm();
                                tools.set_input(None);
                                fail(&mut session, error);
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tools.disarm();
                            tools.set_input(None);
                            fail(&mut session, error);
                        }
                    }
                }
                if deadline.is_some_and(|end| Instant::now() >= end) && session.record.unsettled {
                    tools.disarm();
                    tools.set_input(None);
                    fail(&mut session, IvyErrorCode::Timeout);
                    deadline = None;
                }
            }
        });
        Self {
            shared,
            child,
            sender,
            gate: Mutex::new(()),
            pending_rotation,
            workspace,
        }
    }

    pub fn set_workspace_publisher(&self, publisher: workspace_hub::Publisher) {
        self.workspace.set_publisher(publisher);
    }

    pub fn set_workspace_capture(&self, capture: workspace_hub::Capture) {
        self.workspace.set_capture(capture);
    }

    pub fn workspace_reply(&self, reply: WorkspaceToolReply) -> Result<(), IvyErrorCode> {
        self.workspace.reply(reply)
    }

    pub fn snapshot(&self) -> Result<IvySnapshot, IvyErrorCode> {
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        if self
            .pending_rotation
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?
            .is_some()
        {
            return Err(IvyErrorCode::Busy);
        }
        self.shared
            .view
            .lock()
            .map(|view| view.snapshot.clone())
            .map_err(|_| IvyErrorCode::Unavailable)
    }
}

impl Drop for IvyHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

use super::connection::connect;
pub(super) use super::connection::fail;
#[cfg(test)]
pub(super) use super::connection::publish_ready;

pub fn validate_submit(request: &IvySubmitRequest) -> Result<(), IvyErrorCode> {
    let valid_id = request.input_id.len() == 36
        && request.input_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        });
    if request.version != 1
        || !valid_id
        || request.text.trim().is_empty()
        || request.text.len() > 8192
    {
        return Err(IvyErrorCode::MalformedRequest);
    }
    Ok(())
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "host_recovery_tests.rs"]
mod recovery_tests;

#[cfg(test)]
#[path = "host_lifecycle_tests.rs"]
mod lifecycle_tests;
