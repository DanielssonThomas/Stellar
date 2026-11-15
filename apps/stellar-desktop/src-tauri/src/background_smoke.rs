use tauri::Manager;

#[tauri::command]
pub async fn background_smoke_start(
    app: tauri::AppHandle,
    resume_only: bool,
) -> Result<(), crate::ivy::contracts::IvyErrorCode> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::ivy::IvyHost>()
            .background_probe(resume_only)
    })
    .await
    .map_err(|_| crate::ivy::contracts::IvyErrorCode::Unavailable)?
}

pub fn check(window: tauri::Webview) {
    let _ = window.eval(include_str!("background_smoke.js"));
}
