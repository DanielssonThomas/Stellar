mod acknowledgment;
pub mod contracts;
mod expression;
mod frames;
mod host;
mod keywords;
mod owned;
use crate::owned_child;
mod process;
mod scratch;
mod state;
mod validation;
mod warm;
mod warm_worker;
use contracts::*;
pub(crate) use expression::Pending as VoiceExpressionPending;
pub use host::SpeechHost;
pub use owned::{OwnedSpeech, SpeechCompletion};

#[tauri::command]
pub fn speech_set_ducking(
    host: tauri::State<'_, crate::volume_ducking::VolumeDucking>,
    request: Option<serde_json::Value>,
) -> Result<(), SpeechError> {
    let request: SpeechDuckingRequest = validation::decode(request)?;
    validation::version(request.version)?;
    host.set_active(request.active)
        .map_err(|_| SpeechError::Unavailable)
}

#[tauri::command]
pub async fn speech_keywords(
    host: tauri::State<'_, SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<KeywordReply, SpeechError> {
    let request: KeywordRequest = validation::decode(request)?;
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.keywords(request))
        .await
        .map_err(|_| SpeechError::Unavailable)?
}

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
pub async fn speech_collect(
    host: tauri::State<'_, SpeechHost>,
    request: Option<serde_json::Value>,
) -> Result<SpeechTranscript, SpeechError> {
    let request: SpeechTranscribeRequest = validation::decode(request)?;
    validation::transcribe(&request)?;
    let completion = host.collect(request)?;
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
    let request: SpeechStopRequest = validation::decode(request)?;
    validation::version(request.version)?;
    host.stop_epoch(&request.epoch)
}
