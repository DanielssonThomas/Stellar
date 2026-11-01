pub mod contracts;
mod domain;

use contracts::{APP_INFO_EVENT, AppInfoError, AppInfoEvent, AppInfoReply, AppInfoRequest};
use tauri::Emitter;

#[tauri::command]
pub fn app_info(
    app: tauri::AppHandle,
    request: Option<serde_json::Value>,
) -> Result<AppInfoReply, AppInfoError> {
    let request: AppInfoRequest =
        serde_json::from_value(request.ok_or(AppInfoError::MalformedRequest {})?)
            .map_err(|_| AppInfoError::MalformedRequest {})?;
    let info = domain::app_info(request)?;
    app.emit_to(
        "main",
        APP_INFO_EVENT,
        AppInfoEvent {
            version: 1,
            info: info.clone(),
        },
    )
    .map_err(|_| AppInfoError::EventUnavailable {})?;
    Ok(info)
}
