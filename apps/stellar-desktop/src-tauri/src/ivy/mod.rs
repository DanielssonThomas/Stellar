mod activity;
#[cfg(test)]
mod activity_tests;
mod connection;
pub mod contracts;
mod host;
mod journal;
mod lifecycle;
#[cfg(test)]
mod lifecycle_tests;
mod observation;
pub mod presentation;
mod presentation_decode;
mod process;
#[cfg(test)]
mod recovery_tests;
mod rotation;
pub(crate) mod runtime;
mod session;
#[cfg(test)]
mod session_tests;
mod state;
mod workspace_capture;
mod workspace_context;
pub mod workspace_contracts;
mod workspace_data;
mod workspace_deadline;
mod workspace_hub;
mod workspace_validate;
#[cfg(test)]
mod workspace_validate_tests;

use contracts::{
    IvyErrorCode, IvyModel, IvyRequest, IvySelectRequest, IvySnapshot, IvySubmitRequest,
};
use host::Action;
pub use host::IvyHost;

#[cfg(test)]
mod text_timing_tests;
#[cfg(all(windows, feature = "native-smoke"))]
pub use workspace_capture::capture as capture_workspace_window;
#[cfg(windows)]
pub use workspace_capture::capture_operation as capture_workspace_operation;

fn validate(request: Option<serde_json::Value>) -> Result<(), IvyErrorCode> {
    let request: IvyRequest =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    if request.version != 1 {
        return Err(IvyErrorCode::MalformedRequest);
    }
    Ok(())
}

#[tauri::command]
pub fn ivy_snapshot(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    host.snapshot()
}

#[tauri::command]
pub fn ivy_connect(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    host.request(Action::Connect)
}

#[tauri::command]
pub fn ivy_submit(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    let request: IvySubmitRequest =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    host.request(Action::Submit(request))
}

#[tauri::command]
pub fn ivy_cancel(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    host.request(Action::Cancel)
}

#[tauri::command]
pub fn ivy_reconcile(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    host.request(Action::Reconcile)
}

#[tauri::command]
pub fn ivy_disconnect(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    host.request(Action::Disconnect)
}

#[tauri::command]
pub async fn ivy_select_session(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    let request: IvySelectRequest =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    if request.version != 1 {
        return Err(IvyErrorCode::MalformedRequest);
    }
    let pending = host.rotate(request.model, false)?;
    tauri::async_runtime::spawn_blocking(move || pending.wait())
        .await
        .map_err(|_| IvyErrorCode::Unavailable)?
}
#[tauri::command]
pub async fn ivy_clear_conversation(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    let pending = host.rotate(IvyModel::Terra, true)?;
    tauri::async_runtime::spawn_blocking(move || pending.wait())
        .await
        .map_err(|_| IvyErrorCode::Unavailable)?
}

#[tauri::command]
pub async fn ivy_new_session(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    let pending = host.lifecycle(lifecycle::Control::NewSession)?;
    tauri::async_runtime::spawn_blocking(move || pending.wait())
        .await
        .map_err(|_| IvyErrorCode::Unavailable)?
}
#[tauri::command]
pub async fn ivy_reload_mcp(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    validate(request)?;
    let pending = host.lifecycle(lifecycle::Control::ReloadMcp)?;
    tauri::async_runtime::spawn_blocking(move || pending.wait())
        .await
        .map_err(|_| IvyErrorCode::Unavailable)?
}
#[tauri::command]
pub fn workspace_tool_reply(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<(), IvyErrorCode> {
    let reply: workspace_contracts::WorkspaceToolReply =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    host.workspace_reply(reply)
}
