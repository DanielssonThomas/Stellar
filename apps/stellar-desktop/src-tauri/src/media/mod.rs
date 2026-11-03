mod browser;
#[cfg(windows)]
#[allow(unsafe_code)]
mod browser_focus;
pub mod contracts;
mod images;
mod navigation;
pub(crate) mod network;
mod proxy;
#[cfg(feature = "native-smoke")]
pub mod smoke;

use contracts::*;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct MediaHost {
    browsers: browser::Browsers,
    images: images::Images,
    proxy: Mutex<Option<Arc<proxy::PublicProxy>>>,
}
impl MediaHost {
    async fn proxy(&self) -> Result<Arc<proxy::PublicProxy>, MediaError> {
        let mut proxy = self.proxy.lock().await;
        if proxy.is_none() {
            *proxy = Some(Arc::new(
                proxy::PublicProxy::start()
                    .await
                    .map_err(|_| MediaError::Unavailable)?,
            ));
        }
        proxy.as_ref().cloned().ok_or(MediaError::Unavailable)
    }
}

#[tauri::command]
pub async fn workspace_browser(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    host: tauri::State<'_, MediaHost>,
    request: BrowserRequest,
) -> Result<(), MediaError> {
    if webview.label() != "main" || request.version != 1 {
        return Err(MediaError::Malformed);
    }
    browser::execute(&app, &host, request.operation).await
}

#[tauri::command]
pub async fn workspace_image(
    webview: tauri::Webview,
    host: tauri::State<'_, MediaHost>,
    request: ImageRequest,
) -> Result<ImagePreview, MediaError> {
    if webview.label() != "main" || request.version != 1 {
        return Err(MediaError::Malformed);
    }
    host.images.preview(request.url, host.proxy().await?).await
}
