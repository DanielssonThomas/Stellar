use super::{
    contracts::*,
    journal::Journal,
    process::{self, Broker, OwnedChild},
    session::Session,
    state::{Publisher, Shared, View},
};
use serde_json::json;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};

pub enum Action {
    Connect,
    Submit(IvySubmitRequest),
    Cancel,
    Reconcile,
    Disconnect,
}
struct Work {
    epoch: u64,
    action: Action,
}
pub struct IvyHost {
    shared: Shared,
    child: OwnedChild,
    sender: SyncSender<Work>,
}

impl IvyHost {
    pub fn shutdown(&self) {
        if let Ok(mut view) = self.shared.view.lock() {
            view.epoch = view.epoch.saturating_add(1);
        }
        process::stop(&self.child);
    }
    pub fn new(directory: &Path, publish: Publisher) -> Self {
        let opened = Journal::open(directory);
        let mut snapshot = IvySnapshot::default();
        match &opened {
            Ok((_, record)) => {
                snapshot.turn_id = record.input_id.clone();
                if record.unsettled {
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
        let child = Arc::new(Mutex::new(None));
        let (sender, receiver) = mpsc::sync_channel::<Work>(4);
        let state = shared.clone();
        let owned = child.clone();
        std::thread::spawn(move || {
            let Ok((journal, record)) = opened else {
                return;
            };
            let mut session = Session {
                journal,
                record,
                broker: None,
                shared: state.clone(),
                epoch: 0,
                buffered: vec![],
                replay: None,
            };
            let mut deadline: Option<Instant> = None;
            loop {
                match receiver.recv_timeout(Duration::from_millis(25)) {
                    Ok(work) => {
                        if !state.current(work.epoch) {
                            continue;
                        }
                        session.epoch = work.epoch;
                        let result = match work.action {
                            Action::Connect => connect(&mut session, owned.clone()),
                            Action::Submit(request) => {
                                deadline = Some(Instant::now() + Duration::from_secs(180));
                                session.submit(request)
                            }
                            Action::Cancel => session.cancel(),
                            Action::Reconcile => session.reconcile(),
                            Action::Disconnect => {
                                session.broker = None;
                                session.restore_admission_state();
                                Ok(())
                            }
                        };
                        if let Err(error) = result {
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
                                fail(&mut session, error);
                            }
                        }
                        Ok(None) => {}
                        Err(error) => fail(&mut session, error),
                    }
                }
                if deadline.is_some_and(|end| Instant::now() >= end) && session.record.unsettled {
                    fail(&mut session, IvyErrorCode::Timeout);
                    deadline = None;
                }
            }
        });
        Self {
            shared,
            child,
            sender,
        }
    }

    pub fn snapshot(&self) -> Result<IvySnapshot, IvyErrorCode> {
        self.shared
            .view
            .lock()
            .map(|view| view.snapshot.clone())
            .map_err(|_| IvyErrorCode::Unavailable)
    }

    pub fn request(&self, action: Action) -> Result<IvySnapshot, IvyErrorCode> {
        let mut view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        match &action {
            Action::Connect
                if matches!(
                    view.snapshot.connection,
                    IvyConnectionState::Connecting | IvyConnectionState::Ready
                ) =>
            {
                return Ok(view.snapshot.clone());
            }
            Action::Submit(request) => {
                validate_submit(request)?;
                if view.snapshot.turn_id.as_deref() == Some(&request.input_id) {
                    return Ok(view.snapshot.clone());
                }
                if view.snapshot.connection != IvyConnectionState::Ready {
                    return Err(IvyErrorCode::Unavailable);
                }
                if matches!(
                    view.snapshot.turn,
                    IvyTurnState::Submitting | IvyTurnState::Admitted | IvyTurnState::Uncertain
                ) {
                    return Err(IvyErrorCode::Busy);
                }
            }
            _ => {}
        }
        let epoch = if matches!(action, Action::Connect | Action::Disconnect) {
            view.epoch.checked_add(1).ok_or(IvyErrorCode::Unavailable)?
        } else {
            view.epoch
        };
        let disconnect = matches!(action, Action::Disconnect);
        let (connection, turn_id) = match &action {
            Action::Connect => (Some(IvyConnectionState::Connecting), None),
            Action::Submit(request) => (None, Some(request.input_id.clone())),
            Action::Disconnect => (Some(IvyConnectionState::Disconnected), None),
            _ => (None, None),
        };
        self.sender
            .try_send(Work { epoch, action })
            .map_err(|_| IvyErrorCode::Busy)?;
        view.epoch = epoch;
        if let Some(connection) = connection {
            view.snapshot.connection = connection;
        }
        if let Some(id) = turn_id {
            view.snapshot.turn = IvyTurnState::Submitting;
            view.snapshot.turn_id = Some(id);
            view.snapshot.items.clear();
        }
        if disconnect
            && matches!(
                view.snapshot.turn,
                IvyTurnState::Submitting | IvyTurnState::Admitted
            )
        {
            view.snapshot.turn = IvyTurnState::Uncertain;
        }
        view.snapshot.error = None;
        let snapshot = view.snapshot.clone();
        drop(view);
        if disconnect {
            process::stop(&self.child);
        }
        self.shared.update(epoch, |_| {});
        Ok(snapshot)
    }
}

impl Drop for IvyHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn connect(session: &mut Session, child: OwnedChild) -> Result<(), IvyErrorCode> {
    session.broker = None;
    session.buffered.clear();
    session.replay = None;
    session.broker = Some(Broker::launch(child)?);
    let ping = session.call("ping", json!({}))?;
    let described = session.call("runtime.describe", json!({}))?;
    if ping.get("pong").and_then(serde_json::Value::as_bool) != Some(true)
        || described.get("profile").and_then(serde_json::Value::as_str) != Some("ivy")
        || described
            .get("protocol")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
    {
        return Err(IvyErrorCode::Protocol);
    }
    session.shared.update(session.epoch, |view| {
        view.connection = IvyConnectionState::Ready;
        view.error = None;
        if session.record.unsettled {
            view.turn = IvyTurnState::Uncertain;
        }
    });
    session.restore_admission_state();
    Ok(())
}

fn fail(session: &mut Session, error: IvyErrorCode) {
    session.broker = None;
    session.shared.update(session.epoch, |view| {
        view.connection = IvyConnectionState::Unavailable;
        view.error = Some(error);
        if session.record.unsettled {
            view.turn = IvyTurnState::Uncertain;
        } else if view.turn == IvyTurnState::Submitting {
            view.turn = IvyTurnState::Idle;
        }
    });
}

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
