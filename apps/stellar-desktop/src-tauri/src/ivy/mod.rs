mod activity;
#[cfg(test)]
mod activity_tests;
#[cfg(test)]
mod background_integrity_tests;
#[cfg(feature = "native-smoke")]
mod background_probe;
#[cfg(test)]
mod background_replay_tests;
mod background_updates;
#[cfg(test)]
mod background_updates_tests;
pub mod chart_contracts;
#[cfg(test)]
mod chart_tests;
mod chart_validate;
mod connection;
#[cfg(all(test, windows))]
mod context_submit_tests;
pub mod contracts;
mod host;
pub(crate) mod inspector;
pub mod inspector_contracts;
mod journal;
mod lifecycle;
mod lifecycle_consent;
mod lifecycle_consumer;
mod lifecycle_contract;
pub mod lifecycle_custody;
#[cfg(test)]
mod lifecycle_custody_tests;
pub mod lifecycle_effect_contracts;
mod lifecycle_effects;
#[cfg(test)]
mod lifecycle_integration_tests;
pub mod lifecycle_ports;
mod lifecycle_receipt;
pub mod lifecycle_speech;
mod lifecycle_store;
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod lifecycle_wire_tests;
#[cfg(test)]
mod native_consent_client;
mod observation;
#[cfg(test)]
mod ordinary_completion_tests;
pub mod presentation;
mod presentation_decode;
mod process;
#[cfg(any(feature = "native-smoke", test))]
mod process_diagnostics;
mod question_contracts;
mod questions;
#[cfg(test)]
mod recovery_tests;
mod response_segments;
#[cfg(test)]
mod response_segments_tests;
mod rotation;
pub(crate) mod runtime;
mod session;
mod session_events;
mod session_receipts;
#[cfg(test)]
mod session_tests;
mod state;
mod update_store;
#[cfg(test)]
mod update_store_tests;
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
pub use workspace_context::{ContextLease, ContextProvider};

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
pub fn ivy_question_reply(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    let request: contracts::IvyQuestionReplyRequest =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    host.question_reply(request)
}

#[tauri::command]
pub async fn ivy_claim_update(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    let request: contracts::IvyClaimUpdateRequest =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    let reply = host.claim_background(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        reply
            .recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|_| IvyErrorCode::Timeout)?
    })
    .await
    .map_err(|_| IvyErrorCode::Unavailable)?
}

#[tauri::command]
pub fn ivy_connect(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    if cfg!(feature = "native-smoke") {
        return Err(IvyErrorCode::Unavailable);
    }
    validate(request)?;
    host.request(Action::Connect)
}

#[tauri::command]
pub fn ivy_submit(
    host: tauri::State<'_, IvyHost>,
    speech: tauri::State<'_, crate::speech::SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    if cfg!(feature = "native-smoke") {
        return Err(IvyErrorCode::Unavailable);
    }
    let request: IvySubmitRequest =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    let expression = if request.voice_utterance == Some(true) {
        speech.take_expression(&request.input_id)
    } else {
        None
    };
    host.request_with_expression(Action::Submit(request), expression)
}

#[tauri::command]
pub fn ivy_cancel(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    if cfg!(feature = "native-smoke") {
        return Err(IvyErrorCode::Unavailable);
    }
    validate(request)?;
    host.request(Action::Cancel)
}

#[tauri::command]
pub fn ivy_reconcile(
    host: tauri::State<'_, IvyHost>,
    request: Option<serde_json::Value>,
) -> Result<IvySnapshot, IvyErrorCode> {
    if cfg!(feature = "native-smoke") {
        return Err(IvyErrorCode::Unavailable);
    }
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
    if cfg!(feature = "native-smoke") {
        return Err(IvyErrorCode::Unavailable);
    }
    let reply: workspace_contracts::WorkspaceToolReply =
        serde_json::from_value(request.ok_or(IvyErrorCode::MalformedRequest)?)
            .map_err(|_| IvyErrorCode::MalformedRequest)?;
    host.workspace_reply(reply)
}

#[cfg(test)]
mod question_tests;
