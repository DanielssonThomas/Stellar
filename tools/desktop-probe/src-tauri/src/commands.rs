use crate::contracts::{ProbeError, ProbeEvent, ProbeReply, ProbeRequest};
use crate::domain;
use tauri::Emitter;

#[tauri::command]
pub fn probe_round_trip(
    app: tauri::AppHandle,
    request: ProbeRequest,
) -> Result<ProbeReply, ProbeError> {
    let reply = domain::evaluate(request)?;
    app.emit_to(
        "main",
        "contract-observed",
        ProbeEvent {
            version: 1,
            reply: reply.clone(),
        },
    )
    .map_err(|_| ProbeError::EventUnavailable {})?;
    Ok(reply)
}
