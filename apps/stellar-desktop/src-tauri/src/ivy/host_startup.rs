use super::super::journal::Record;
use super::*;
use std::path::Path;

/// Keep the worker alive after a failed journal open; only Connect retries ownership.
pub(super) fn acquire(
    initial: Result<(Journal, Record), IvyErrorCode>,
    directory: &Path,
    receiver: &mpsc::Receiver<Work>,
    state: &Shared,
    rotations: &Pending,
) -> Option<(Journal, Record, Option<Work>)> {
    let mut last_error = match initial {
        Ok((journal, record)) => return Some((journal, record, None)),
        Err(error) => error,
    };
    loop {
        let work = receiver.recv().ok()?;
        if !state.current(work.epoch) {
            reject_rotation(work.action, rotations, IvyErrorCode::Unavailable);
            continue;
        }
        if matches!(work.action, Action::Connect) {
            match Journal::open(directory) {
                Ok((journal, record)) => {
                    state.update(work.epoch, |view| {
                        view.turn_id = record.input_id.clone();
                        view.model = record.model;
                        view.verified_model = None;
                        view.workspace_tools = WorkspaceToolsState::Unavailable;
                        view.turn = if record.unsettled || record.pending_reset.is_some() {
                            IvyTurnState::Uncertain
                        } else {
                            IvyTurnState::Idle
                        };
                        view.items.clear();
                        view.response_segments.clear();
                        view.error = None;
                    });
                    return Some((journal, record, Some(work)));
                }
                Err(error) => last_error = error,
            }
        }
        state.update(work.epoch, |view| {
            view.connection = IvyConnectionState::Unavailable;
            view.error = Some(last_error.clone());
        });
        reject_rotation(work.action, rotations, last_error.clone());
    }
}

fn reject_rotation(action: Action, rotations: &Pending, error: IvyErrorCode) {
    if let Action::Rotate(_, _, ticket, reply) | Action::Lifecycle(_, ticket, reply) = action {
        rotation::finish(rotations, &ticket);
        let _ = reply.send(Err(error));
    }
}
#[cfg(test)]
#[path = "host_startup_tests.rs"]
mod tests;
