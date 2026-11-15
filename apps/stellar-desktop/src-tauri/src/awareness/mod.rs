pub mod contracts;
mod host;
mod state;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_process;

use contracts::*;
pub use host::AwarenessHost;

#[tauri::command]
pub fn awareness_snapshot(
    host: tauri::State<'_, AwarenessHost>,
    request: AwarenessRequest,
) -> Result<AwarenessSnapshot, AwarenessError> {
    if request.version != 1 {
        return Err(AwarenessError::MalformedRequest);
    }
    host.snapshot()
}

#[tauri::command]
pub fn awareness_set_enabled(
    host: tauri::State<'_, AwarenessHost>,
    request: AwarenessSetEnabled,
) -> Result<AwarenessSnapshot, AwarenessError> {
    if request.version != 1 {
        return Err(AwarenessError::MalformedRequest);
    }
    host.set_enabled(request.enabled)
}

#[tauri::command]
pub fn awareness_workspace(
    host: tauri::State<'_, AwarenessHost>,
    ivy: tauri::State<'_, crate::ivy::IvyHost>,
    request: AwarenessWorkspace,
) -> Result<(), AwarenessError> {
    let snapshot = ivy.snapshot().map_err(|_| AwarenessError::Unavailable)?;
    if snapshot.workspace_epoch != request.epoch {
        return Err(AwarenessError::Unavailable);
    }
    host.workspace(request)
}
