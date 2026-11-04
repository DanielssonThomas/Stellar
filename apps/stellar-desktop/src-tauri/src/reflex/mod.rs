mod admission;
pub mod contracts;
mod media_host;
mod model;
mod process;
mod prompt;
mod setup;
#[cfg(windows)]
mod windows_media;
#[cfg(windows)]
mod windows_volume;
use contracts::*;
pub use media_host::MediaHost;
pub use model::ReflexHost;

#[tauri::command]
pub async fn reflex_prepare(host: tauri::State<'_, ReflexHost>) -> Result<ReflexAvailability, ()> {
    Ok(ReflexAvailability {
        version: 1,
        configured: host.prepare().await,
    })
}

#[tauri::command]
pub async fn reflex_status() -> Result<ReflexAvailability, ()> {
    tauri::async_runtime::spawn_blocking(|| ReflexAvailability {
        version: 1,
        configured: setup::configuration().is_some(),
    })
    .await
    .map_err(|_| ())
}

#[tauri::command]
pub async fn reflex_set_enabled(
    host: tauri::State<'_, ReflexHost>,
    media: tauri::State<'_, std::sync::Arc<MediaHost>>,
    enabled: bool,
) -> Result<(), ()> {
    media.set_enabled(enabled);
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.set_enabled(enabled))
        .await
        .map_err(|_| ())
}

#[tauri::command]
pub async fn reflex_infer(
    host: tauri::State<'_, ReflexHost>,
    request: ReflexRequest,
) -> Result<ReflexReply, ()> {
    let plan = host.infer(&request).await;
    Ok(ReflexReply {
        version: 1,
        input_id: request.input_id,
        plan,
    })
}

#[tauri::command]
pub async fn reflex_cancel(
    host: tauri::State<'_, ReflexHost>,
    media: tauri::State<'_, std::sync::Arc<MediaHost>>,
    input_id: String,
) -> Result<(), ()> {
    media.cancel(&input_id);
    let host = host.inner().clone();
    let _ = tauri::async_runtime::spawn_blocking(move || host.cancel(Some(&input_id))).await;
    Ok(())
}

#[tauri::command]
pub async fn reflex_media_snapshot(
    host: tauri::State<'_, std::sync::Arc<MediaHost>>,
) -> Result<ReflexMediaState, ()> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            host.snapshot(&windows_media::WindowsMedia)
        }
        #[cfg(not(windows))]
        {
            let _ = host;
            Err(())
        }
    })
    .await
    .map_err(|_| ())?
}

#[tauri::command]
pub async fn reflex_media_execute(
    host: tauri::State<'_, std::sync::Arc<MediaHost>>,
    request: ReflexMediaRequest,
) -> Result<ReflexMediaResult, ()> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            host.execute(&request, &windows_media::WindowsMedia)
        }
        #[cfg(not(windows))]
        {
            let _ = (host, request);
            ReflexMediaResult::Rejected
        }
    })
    .await
    .map_err(|_| ())
}

#[cfg(test)]
#[path = "prompt_tests.rs"]
mod tests;
