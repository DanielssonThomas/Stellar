use super::super::inspector_contracts::{IvyInspectorRequest, IvyInspectorSnapshot};
use super::*;

pub(super) fn run(
    session: &mut Session,
    request: IvyInspectorRequest,
    reply: mpsc::SyncSender<Result<IvyInspectorSnapshot, IvyErrorCode>>,
) -> Result<(), IvyErrorCode> {
    use super::super::inspector::InspectionError;
    let result = super::super::inspector::inspect(session, request);
    match result {
        Ok(snapshot) => {
            let _ = reply.send(Ok(snapshot));
            Ok(())
        }
        Err(InspectionError::Data(error)) => {
            let _ = reply.send(Err(error));
            Ok(())
        }
        Err(InspectionError::Session(error)) => {
            let _ = reply.send(Err(error.clone()));
            Err(error)
        }
    }
}

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
                context: None,
            })
            .map_err(|_| IvyErrorCode::Busy)?;
        Ok(rx)
    }
}

#[cfg(all(test, windows))]
#[path = "host_inspector_tests.rs"]
mod tests;
