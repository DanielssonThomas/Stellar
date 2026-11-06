use super::{
    contracts::*,
    journal::WorkspaceDescriptor,
    process::{Broker, OwnedChild},
    session::Session,
    workspace_hub::WorkspaceHub,
};
use serde_json::json;
use std::sync::Arc;

pub(super) fn connect(
    session: &mut Session,
    child: OwnedChild,
    workspace: Arc<WorkspaceHub>,
) -> Result<(), IvyErrorCode> {
    session.broker = None;
    session.buffered.clear();
    session.replay = None;
    let mut broker = Broker::launch(child)?;
    workspace.set_input(Some(broker.input()));
    let image_endpoint = workspace.image_endpoint();
    broker.set_workspace(
        Arc::new(move |frame| workspace.handle(frame)),
        image_endpoint,
    );
    session.broker = Some(broker);
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
    if let Some(descriptor) = session.record.workspace.clone() {
        let expected = serde_json::to_value(&descriptor).map_err(|_| IvyErrorCode::Protocol)?;
        let actual = session.call(
            "workspace.setup",
            json!({
                "descriptor": expected,
                "session_id": session.record.session_id,
            }),
        )?;
        let restored: WorkspaceDescriptor = session
            .broker
            .as_ref()
            .ok_or(IvyErrorCode::Unavailable)?
            .configure_workspace(actual)?;
        if restored != descriptor {
            return Err(IvyErrorCode::Protocol);
        }
    }
    publish_ready(session);
    Ok(())
}

pub(super) fn publish_ready(session: &Session) {
    session.restore_admission_state();
    session.shared.update(session.epoch, |view| {
        view.connection = IvyConnectionState::Ready;
        view.workspace_tools = WorkspaceToolsState::Unavailable;
        view.error = None;
    });
}

pub(super) fn fail(session: &mut Session, error: IvyErrorCode) {
    session.broker = None;
    session.shared.update(session.epoch, |view| {
        view.connection = IvyConnectionState::Unavailable;
        view.activity.clear();
        view.questions = None;
        view.verified_model = None;
        view.workspace_tools = WorkspaceToolsState::Unavailable;
        view.error = Some(error);
        if session.record.unsettled {
            view.turn = IvyTurnState::Uncertain;
        } else if view.turn == IvyTurnState::Submitting {
            view.turn = IvyTurnState::Idle;
        }
    });
}
