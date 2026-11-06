use super::super::inspector_contracts::{IvyInspectorRequest, IvyInspectorSnapshot};
use super::*;

impl IvyHost {
    pub fn inspect(
        &self,
        request: IvyInspectorRequest,
    ) -> Result<mpsc::Receiver<Result<IvyInspectorSnapshot, IvyErrorCode>>, IvyErrorCode> {
        super::super::inspector::validate_request(&request)?;
        let _guard = self.gate.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let view = self
            .shared
            .view
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if view.snapshot.connection != IvyConnectionState::Ready {
            return Err(IvyErrorCode::Unavailable);
        }
        if self
            .pending_rotation
            .lock()
            .map_err(|_| IvyErrorCode::Unavailable)?
            .is_some()
        {
            return Err(IvyErrorCode::Busy);
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
                action: Action::Inspect(request, tx),
            })
            .map_err(|_| IvyErrorCode::Busy)?;
        Ok(rx)
    }
}
