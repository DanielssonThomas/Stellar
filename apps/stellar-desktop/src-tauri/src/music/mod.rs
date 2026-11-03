#[allow(dead_code)]
mod command_names;
pub mod contracts;
pub use command_names::MUSIC_EVENT;
mod capture;
mod dsp;
mod host;
use contracts::{MusicError, MusicRequest, MusicSnapshot};
pub use host::MusicHost;

#[tauri::command]
pub fn music_set_enabled(
    window: tauri::WebviewWindow,
    host: tauri::State<'_, MusicHost>,
    request: Option<serde_json::Value>,
) -> Result<MusicSnapshot, MusicError> {
    if window.label() != "main" {
        return Err(MusicError::Unavailable);
    }
    let request = decode_request(request)?;
    host.set_enabled(request.enabled)
        .map_err(|_| MusicError::Unavailable)
}

fn decode_request(value: Option<serde_json::Value>) -> Result<MusicRequest, MusicError> {
    let request: MusicRequest = value
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or(MusicError::Malformed)?;
    if request.version != 1 {
        return Err(MusicError::UnsupportedVersion);
    }
    Ok(request)
}

#[cfg(test)]
mod music_tests;
#[cfg(all(test, windows))]
mod windows_tests;
