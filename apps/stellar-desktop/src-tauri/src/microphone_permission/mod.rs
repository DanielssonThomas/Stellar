pub mod contracts;
mod policy;
#[cfg(all(windows, not(feature = "native-smoke")))]
#[allow(unsafe_code)]
mod windows;

pub use policy::ReviewHost;

#[tauri::command]
pub async fn microphone_permission_review(
    view: tauri::Webview,
    host: tauri::State<'_, ReviewHost>,
    request: Option<serde_json::Value>,
) -> Result<contracts::MicrophoneReviewReply, contracts::MicrophoneReviewError> {
    use contracts::MicrophoneReviewError;
    let url = view.url().map_err(|_| MicrophoneReviewError::Unavailable)?;
    policy::validate(view.label(), &url, request)?;
    let _lease = host.begin()?;
    let outcome = platform_review(view, _lease.token()).await?;
    Ok(contracts::MicrophoneReviewReply {
        version: 1,
        outcome,
    })
}

#[cfg(all(windows, not(feature = "native-smoke")))]
use windows::review as platform_review;
#[cfg(any(not(windows), feature = "native-smoke"))]
async fn platform_review(
    _: tauri::Webview,
    _: policy::ReviewToken,
) -> Result<contracts::MicrophoneReviewOutcome, contracts::MicrophoneReviewError> {
    Err(contracts::MicrophoneReviewError::Unsupported)
}
