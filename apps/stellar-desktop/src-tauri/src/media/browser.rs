use super::{MediaHost, contracts::*, navigation::Navigation, network};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{
    Emitter, Manager, WebviewUrl,
    webview::{NewWindowResponse, PermissionResponse, WebviewBuilder},
};

#[derive(Default)]
pub struct Browsers {
    ids: Mutex<HashMap<String, Arc<Navigation>>>,
}

fn identifier(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
fn label(id: &str) -> String {
    format!("workspace-browser-{id}")
}
fn viewport(app: &tauri::AppHandle, bounds: BrowserBounds) -> Result<BrowserBounds, MediaError> {
    if [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .any(|n| !n.is_finite() || *n < 0.)
    {
        return Err(MediaError::Malformed);
    }
    let window = app.get_window("main").ok_or(MediaError::Unavailable)?;
    let scale = window.scale_factor().map_err(|_| MediaError::Unavailable)?;
    let size = window
        .inner_size()
        .map_err(|_| MediaError::Unavailable)?
        .to_logical::<f64>(scale);
    let x = bounds.x.min(size.width);
    let y = bounds.y.min(size.height);
    Ok(BrowserBounds {
        x,
        y,
        width: bounds.width.min(size.width - x),
        height: bounds.height.min(size.height - y),
        visible: bounds.visible,
    })
}

fn bounds(view: &tauri::Webview, b: &BrowserBounds) -> Result<(), MediaError> {
    if !b.visible || b.width < 32. || b.height < 32. {
        return view.hide().map_err(|_| MediaError::Unavailable);
    }
    view.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(b.x, b.y).into(),
        size: tauri::LogicalSize::new(b.width, b.height).into(),
    })
    .map_err(|_| MediaError::Unavailable)?;
    view.show().map_err(|_| MediaError::Unavailable)
}

pub async fn execute(
    app: &tauri::AppHandle,
    host: &MediaHost,
    action: BrowserAction,
) -> Result<(), MediaError> {
    if let BrowserAction::External { url } = action {
        let url = network::url(&url).map_err(|_| MediaError::Blocked)?;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            network::addresses(url.host_str().ok_or(MediaError::Blocked)?),
        )
        .await
        .map_err(|_| MediaError::Unavailable)?
        .map_err(|_| MediaError::Blocked)?;
        return external(url.as_str());
    }
    let id = match &action {
        BrowserAction::Open { id, .. }
        | BrowserAction::Navigate { id, .. }
        | BrowserAction::Bounds { id, .. }
        | BrowserAction::Back { id, .. }
        | BrowserAction::Forward { id, .. }
        | BrowserAction::Reload { id, .. }
        | BrowserAction::Close { id } => id,
        BrowserAction::External { .. } => unreachable!(),
    };
    if !identifier(id) {
        return Err(MediaError::Malformed);
    }
    if let BrowserAction::Open {
        id,
        url,
        bounds: requested,
        generation,
    } = &action
    {
        if *generation == 0 {
            return Err(MediaError::Malformed);
        }
        let counter = Arc::new(Navigation::new(*generation));
        let url = network::url(url).map_err(|_| MediaError::Blocked)?;
        let requested = viewport(app, requested.clone())?;
        let proxy = host.proxy().await?;
        {
            let mut ids = host
                .browsers
                .ids
                .lock()
                .map_err(|_| MediaError::Unavailable)?;
            if ids.contains_key(id) {
                return Err(MediaError::Malformed);
            }
            if ids.len() >= 2 {
                return Err(MediaError::Limit);
            }
            ids.insert(id.clone(), counter.clone());
        }
        let result = create(app, id, url, &requested, proxy.port, counter).await;
        if result.is_err() {
            host.browsers
                .ids
                .lock()
                .map_err(|_| MediaError::Unavailable)?
                .retain(|key, _| key != id);
        }
        return result;
    }
    if let BrowserAction::Close { .. } = &action {
        if let Some(view) = app.get_webview(&label(id)) {
            view.close().map_err(|_| MediaError::Unavailable)?;
        }
        host.browsers
            .ids
            .lock()
            .map_err(|_| MediaError::Unavailable)?
            .retain(|key, _| key != id);
        return Ok(());
    }
    let view = app.get_webview(&label(id)).ok_or(MediaError::Unavailable)?;
    let generation = match &action {
        BrowserAction::Navigate { generation, .. }
        | BrowserAction::Back { generation, .. }
        | BrowserAction::Forward { generation, .. }
        | BrowserAction::Reload { generation, .. } => Some(*generation),
        _ => None,
    };
    if let Some(generation) = generation {
        let counter = host
            .browsers
            .ids
            .lock()
            .map_err(|_| MediaError::Unavailable)?
            .get(id)
            .cloned()
            .ok_or(MediaError::Unavailable)?;
        counter
            .advance(
                &view,
                generation,
                !matches!(&action, BrowserAction::Reload { .. }),
            )
            .await?;
    }
    match action {
        BrowserAction::Navigate { url, .. } => {
            view.navigate(network::url(&url).map_err(|_| MediaError::Blocked)?)
        }
        BrowserAction::Bounds {
            bounds: requested, ..
        } => return bounds(&view, &viewport(app, requested)?),
        BrowserAction::Back { .. } => view.eval("window.history.back()"),
        BrowserAction::Forward { .. } => view.eval("window.history.forward()"),
        BrowserAction::Reload { .. } => view.reload(),
        _ => return Err(MediaError::Malformed),
    }
    .map_err(|_| MediaError::Unavailable)
}

async fn create(
    app: &tauri::AppHandle,
    id: &str,
    url: tauri::Url,
    requested: &BrowserBounds,
    port: u16,
    counter: Arc<Navigation>,
) -> Result<(), MediaError> {
    let nav_counter = counter.clone();
    let focus_counter = counter.clone();
    let nav_app = app.clone();
    let nav_id = id.to_owned();
    let page_id = id.to_owned();
    // Wry's additional_browser_args replaces its defaults, including proxy_url. Set the proxy here.
    let args = format!(
        "--proxy-server=http://127.0.0.1:{port} --proxy-bypass-list=<-loopback> --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=user-gesture-required"
    );
    let builder = WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .data_directory(
            app.path()
                .app_cache_dir()
                .map_err(|_| MediaError::Unavailable)?
                .join("public-browser-v1"),
        )
        .incognito(true)
        .initialization_script("Object.defineProperty(window,'__stellarDocumentId',{value:crypto.randomUUID(),writable:false,configurable:false});")
        .additional_browser_args(&args)
        .devtools(false)
        .focused(false)
        .disable_drag_drop_handler()
        .on_download(|_, _| false)
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_navigation(move |url| {
            let allowed = network::url(url.as_str()).is_ok();
            let _ = nav_app.emit_to(
                "main",
                "stellar-browser",
                BrowserEvent {
                    id: nav_id.clone(),
                    generation:nav_counter.generation(),
                    url: url.as_str().chars().take(2048).collect(),
                    state: if allowed {
                        BrowserLoadState::Loading
                    } else {
                        BrowserLoadState::Blocked
                    },
                },
            );
            allowed
        })
        .on_page_load(move|view,event|{
            if matches!(event.event(),tauri::webview::PageLoadEvent::Finished) {Navigation::publish(view,page_id.clone(),counter.clone());}
        });
    let window = app.get_window("main").ok_or(MediaError::Unavailable)?;
    let view = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(requested.x, requested.y),
            tauri::LogicalSize::new(requested.width.max(32.), requested.height.max(32.)),
        )
        .map_err(|_| MediaError::Unavailable)?;
    #[cfg(windows)]
    if let Err(error) = super::browser_focus::observe(&view, id.to_owned(), focus_counter).await {
        let _ = view.close();
        return Err(error);
    }
    if let Err(error) = bounds(&view, requested) {
        let _ = view.close();
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
fn external(url: &str) -> Result<(), MediaError> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(0x08000000)
        .spawn()
        .map(|_| ())
        .map_err(|_| MediaError::Unavailable)
}
#[cfg(not(windows))]
fn external(_: &str) -> Result<(), MediaError> {
    Err(MediaError::Unavailable)
}
