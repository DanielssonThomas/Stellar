use tauri::Manager;
use tokio::sync::oneshot;

#[tauri::command]
pub async fn smoke_media_probe(app: tauri::AppHandle, retained: Option<bool>) -> bool {
    let Some(view) = app.get_webview("workspace-browser-00000000-0000-4000-8000-000000000001")
    else {
        return false;
    };
    if view.set_focus().is_err() {
        return false;
    }
    // Only the smoke build evaluates this fixed isolation probe; no evaluation tool is exposed.
    let script = r#"(async()=>{
        let denied=false;
        try { await window.__TAURI__.core.invoke('shell_status',{request:{version:1}}); }
        catch { denied=true; }
        window.__stellarSmokeProbe={denied,title:document.title};
    })()"#;
    if retained != Some(true) && view.eval(script).is_err() {
        return false;
    }
    if retained != Some(true) {
        let _ = view.eval("history.pushState({},'', '#stellar-source-smoke')");
    }
    let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await else {
        return false;
    };
    let Ok(address) = listener.local_addr() else {
        return false;
    };
    let script = format!(
        "fetch('https://127.0.0.1:{}/stellar-private-probe',{{mode:'no-cors'}}).catch(()=>{{}})",
        address.port()
    );
    if view.eval(script).is_err()
        || tokio::time::timeout(std::time::Duration::from_secs(1), listener.accept())
            .await
            .is_ok()
    {
        return false;
    }
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let (send, receive) = oneshot::channel();
        let send = std::sync::Mutex::new(Some(send));
        if view
            .eval_with_callback(
                "JSON.stringify(window.__stellarSmokeProbe ?? null)",
                move |value| {
                    if let Ok(mut sender) = send.lock()
                        && let Some(sender) = sender.take()
                    {
                        let _ = sender.send(value);
                    }
                },
            )
            .is_err()
        {
            return false;
        }
        let Ok(Ok(value)) = tokio::time::timeout(std::time::Duration::from_secs(1), receive).await
        else {
            return false;
        };
        if value.contains("Example Domain") && value.contains("true") {
            #[cfg(windows)]
            {
                let Ok(image) = crate::ivy::capture_workspace_window(&app) else {
                    return false;
                };
                if std::fs::create_dir_all("artifacts/native").is_err()
                    || std::fs::write("artifacts/native/workspace-browser.png", image).is_err()
                {
                    return false;
                }
            }
            return true;
        }
    }
    false
}
