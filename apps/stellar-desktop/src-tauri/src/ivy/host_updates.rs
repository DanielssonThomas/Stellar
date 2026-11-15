use super::*;

impl IvyHost {
    pub fn claim_background(
        &self,
        request: IvyClaimUpdateRequest,
    ) -> Result<mpsc::Receiver<Result<IvySnapshot, IvyErrorCode>>, IvyErrorCode> {
        if request.version != 1 || request.update_id.is_empty() || request.update_id.len() > 512 {
            return Err(IvyErrorCode::MalformedRequest);
        }
        requests::validate_submit(&IvySubmitRequest {
            version: 1,
            input_id: request.request_id.clone(),
            text: "claim".into(),
            local_actions: None,
            voice_utterance: Some(false),
        })?;
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        if self
            .pending_rotation
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?
            .is_some()
        {
            return Err(IvyErrorCode::Busy);
        }
        let view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if view.snapshot.connection != IvyConnectionState::Ready
            || !view
                .snapshot
                .background_updates
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|u| u.id == request.update_id)
        {
            return Err(IvyErrorCode::Unavailable);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .try_send(Work {
                epoch: view.epoch,
                workspace_epoch: view
                    .snapshot
                    .workspace_epoch
                    .parse()
                    .map_err(|_| IvyErrorCode::Protocol)?,
                action: Action::ClaimUpdate(request, tx),
                context: None,
                expression: None,
            })
            .map_err(|_| IvyErrorCode::Busy)?;
        Ok(rx)
    }
}
