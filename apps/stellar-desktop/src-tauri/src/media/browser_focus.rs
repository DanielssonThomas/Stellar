use super::{
    contracts::{BrowserEvent, BrowserLoadState, MediaError},
    navigation::Navigation,
};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;
use webview2_com::{FocusChangedEventHandler, SourceChangedEventHandler};

pub async fn observe(
    view: &tauri::Webview,
    id: String,
    owner: Arc<Navigation>,
) -> Result<(), MediaError> {
    let app = view.app_handle().clone();
    let (send, receive) = oneshot::channel();
    view.with_webview(move |native| {
        let source_app = app.clone();
        let source_id = id.clone();
        let source_owner = owner.clone();
        let source = SourceChangedEventHandler::create(Box::new(move |_, _| {
            if let Some(view) = source_app.get_webview(&format!("workspace-browser-{}", source_id))
            {
                Navigation::publish(view, source_id.clone(), source_owner.clone());
            }
            Ok(())
        }));
        let handler = FocusChangedEventHandler::create(Box::new(move |_, _| {
            let _ = app.emit_to(
                "main",
                "stellar-browser",
                BrowserEvent {
                    id: id.clone(),
                    generation: owner.generation(),
                    url: String::new(),
                    state: BrowserLoadState::Focused,
                },
            );
            Ok(())
        }));
        let mut token = 0;
        let mut source_token = 0;
        // SAFETY: Tauri runs this closure on the controller's owning UI thread and supplies
        // a live, reference-counted controller. WebView2 writes only the valid stack token;
        // it retains the reference-counted handler until this controller is closed. The
        // callbacks capture no COM pointers/controller. SourceChanged also covers fragment/SPA
        // history updates. Both handlers are released when this child is closed.
        let result = unsafe {
            let controller = native.controller();
            match controller.add_GotFocus(&handler, &mut token) {
                Ok(()) => match controller.CoreWebView2() {
                    Ok(webview) => webview.add_SourceChanged(&source, &mut source_token),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            }
        }
        .map_err(|_| MediaError::Unavailable);
        let _ = send.send(result);
    })
    .map_err(|_| MediaError::Unavailable)?;
    tokio::time::timeout(std::time::Duration::from_secs(2), receive)
        .await
        .map_err(|_| MediaError::Unavailable)?
        .map_err(|_| MediaError::Unavailable)?
}
