use super::*;

impl IvyHost {
    pub fn lifecycle(
        &self,
        control: super::super::lifecycle::Control,
    ) -> Result<RotationReply, IvyErrorCode> {
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let mut view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if view.snapshot.connection != IvyConnectionState::Ready {
            return Err(IvyErrorCode::Unavailable);
        }
        if matches!(
            view.snapshot.turn,
            IvyTurnState::Submitting | IvyTurnState::Admitted | IvyTurnState::Uncertain
        ) {
            return Err(IvyErrorCode::Busy);
        }
        let mut slot = self
            .pending_rotation
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if slot.is_some() {
            return Err(IvyErrorCode::Busy);
        }
        let ticket = rotation::ticket();
        let (tx, rx) = mpsc::sync_channel(1);
        let workspace_epoch = view
            .snapshot
            .workspace_epoch
            .parse::<u64>()
            .map_err(|_| IvyErrorCode::Protocol)?
            .checked_add(1)
            .ok_or(IvyErrorCode::Unavailable)?;
        *slot = Some(ticket.clone());
        if self
            .sender
            .try_send(Work {
                epoch: view.epoch,
                workspace_epoch,
                action: Action::Lifecycle(control, ticket.clone(), tx),
            })
            .is_err()
        {
            *slot = None;
            return Err(IvyErrorCode::Busy);
        }
        view.snapshot.workspace_epoch = workspace_epoch.to_string();
        drop(slot);
        drop(view);
        self.workspace.disarm();
        Ok(RotationReply {
            rx,
            pending: self.pending_rotation.clone(),
            ticket,
            timeout: Duration::from_secs(20),
        })
    }
    pub fn rotate(&self, model: IvyModel, force: bool) -> Result<RotationReply, IvyErrorCode> {
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let mut view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if matches!(
            view.snapshot.turn,
            IvyTurnState::Submitting | IvyTurnState::Admitted | IvyTurnState::Uncertain
        ) {
            return Err(IvyErrorCode::Busy);
        }
        let mut slot = self
            .pending_rotation
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if slot.is_some() {
            return Err(IvyErrorCode::Busy);
        }
        if !force
            && view.snapshot.connection == IvyConnectionState::Ready
            && view.snapshot.model == model
            && view.snapshot.verified_model == Some(model)
            && view.snapshot.error.is_none()
        {
            let (tx, rx) = mpsc::sync_channel(1);
            tx.send(Ok(view.snapshot.clone()))
                .map_err(|_| IvyErrorCode::Unavailable)?;
            return Ok(RotationReply {
                rx,
                pending: self.pending_rotation.clone(),
                ticket: rotation::ticket(),
                timeout: Duration::from_secs(2),
            });
        }
        let workspace_epoch = view
            .snapshot
            .workspace_epoch
            .parse::<u64>()
            .map_err(|_| IvyErrorCode::Protocol)?
            .checked_add(1)
            .ok_or(IvyErrorCode::Unavailable)?;
        let ticket = rotation::ticket();
        *slot = Some(ticket.clone());
        let (tx, rx) = mpsc::sync_channel(1);
        if self
            .sender
            .try_send(Work {
                epoch: view.epoch,
                workspace_epoch,
                action: Action::Rotate(model, force, ticket.clone(), tx),
            })
            .is_err()
        {
            *slot = None;
            return Err(IvyErrorCode::Busy);
        }
        view.snapshot.workspace_epoch = workspace_epoch.to_string();
        let epoch = view.epoch;
        drop(slot);
        drop(view);
        self.workspace.disarm();
        self.shared.update(epoch, |_| {});
        Ok(RotationReply {
            rx,
            pending: self.pending_rotation.clone(),
            ticket,
            timeout: Duration::from_secs(2),
        })
    }
    pub fn request(&self, action: Action) -> Result<IvySnapshot, IvyErrorCode> {
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let mut view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        let action = if matches!(action, Action::Connect)
            && view.snapshot.connection == IvyConnectionState::Ready
            && view.snapshot.turn == IvyTurnState::Uncertain
        {
            Action::Reconcile
        } else {
            action
        };
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
                if self
                    .pending_rotation
                    .lock()
                    .map_err(|_| IvyErrorCode::Unavailable)?
                    .is_some()
                {
                    return Err(IvyErrorCode::Busy);
                }
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
        let previous_workspace_epoch = view
            .snapshot
            .workspace_epoch
            .parse::<u64>()
            .map_err(|_| IvyErrorCode::Protocol)?;
        let workspace_epoch = if matches!(
            action,
            Action::Connect | Action::Disconnect | Action::Cancel | Action::Submit(_)
        ) {
            previous_workspace_epoch
                .checked_add(1)
                .ok_or(IvyErrorCode::Unavailable)?
        } else {
            previous_workspace_epoch
        };
        let disconnect = matches!(action, Action::Disconnect);
        let cancel = matches!(action, Action::Cancel);
        if disconnect {
            let ticket = self
                .pending_rotation
                .lock()
                .map_err(|_| IvyErrorCode::Unavailable)?
                .clone();
            if let Some(ticket) = ticket {
                rotation::cancel(&self.pending_rotation, &ticket);
            }
        }
        let (connection, turn_id) = match &action {
            Action::Connect => (Some(IvyConnectionState::Connecting), None),
            Action::Submit(request) => (None, Some(request.input_id.clone())),
            Action::Disconnect => (Some(IvyConnectionState::Disconnected), None),
            _ => (None, None),
        };
        self.sender
            .try_send(Work {
                epoch,
                workspace_epoch,
                action,
            })
            .map_err(|_| IvyErrorCode::Busy)?;
        view.epoch = epoch;
        view.snapshot.workspace_epoch = workspace_epoch.to_string();
        if let Some(connection) = connection {
            view.snapshot.connection = connection;
        }
        if let Some(id) = turn_id {
            view.snapshot.questions = None;
            view.snapshot.first_text_observed = None;
            view.snapshot.turn = IvyTurnState::Submitting;
            view.snapshot.turn_id = Some(id);
            view.snapshot.items.clear();
            view.snapshot.activity.clear();
        }
        if disconnect || cancel {
            view.snapshot.questions = None;
            view.snapshot.activity.clear();
        }
        if disconnect {
            view.snapshot.verified_model = None;
            view.snapshot.workspace_tools = WorkspaceToolsState::Unavailable;
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
        if disconnect || cancel {
            self.workspace.disarm();
        }
        if disconnect {
            process::stop(&self.child);
            self.workspace.set_input(None);
        }
        self.shared.update(epoch, |_| {});
        Ok(snapshot)
    }
}
pub(in crate::ivy) fn validate_submit(request: &IvySubmitRequest) -> Result<(), IvyErrorCode> {
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
