pub mod contracts;
mod host;
mod journal;
pub mod presentation;
mod presentation_decode;
mod process;
pub(crate) mod runtime;
mod session;
#[cfg(test)]
mod session_tests;
mod state;

use contracts::{IvyErrorCode, IvyRequest, IvySnapshot, IvySubmitRequest};
use host::Action;
pub use host::IvyHost;

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
