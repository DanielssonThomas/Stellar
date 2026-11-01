pub mod contracts;
mod frames;
mod host;
mod process;
mod scratch;
mod validation;
use contracts::*;
pub use host::SpeechHost;

#[tauri::command]
pub fn speech_snapshot(
    host: tauri::State<'_, SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<SpeechSnapshot, SpeechError> {
    let request: SpeechRequest = validation::decode(request)?;
    validation::version(request.version)?;
    host.snapshot()
}

#[tauri::command]
pub async fn speech_transcribe(
    host: tauri::State<'_, SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<SpeechTranscript, SpeechError> {
    let request: SpeechTranscribeRequest = validation::decode(request)?;
    validation::transcribe(&request)?;
    let completion = host.transcribe(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        completion.recv().map_err(|_| SpeechError::Unavailable)?
    })
    .await
    .map_err(|_| SpeechError::Unavailable)?
}

#[tauri::command]
pub fn speech_speak(
    host: tauri::State<'_, SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<SpeechSnapshot, SpeechError> {
    host.speak(validation::decode(request)?)
}

#[tauri::command]
pub fn speech_stop(
    host: tauri::State<'_, SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<SpeechSnapshot, SpeechError> {
    let request: SpeechRequest = validation::decode(request)?;
    validation::version(request.version)?;
    host.stop()
}
