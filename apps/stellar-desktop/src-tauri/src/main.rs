#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_info;
mod commands;
mod contracts;
mod ivy;
mod shell;
#[cfg(feature = "native-smoke")]
mod smoke;

fn main() {
    use tauri::{Emitter, Manager};
    debug_assert_eq!(ivy::contracts::IVY_COMMANDS.len(), 6);
    let navigation = tauri::plugin::Builder::<tauri::Wry>::new("local-navigation")
        .on_navigation(|_, url| {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        })
        .build();
    let builder = tauri::Builder::default()
        .plugin(navigation)
        .setup(|app| {
            let handle = app.handle().clone();
            let directory = app.path().app_local_data_dir()?.join("ivy");
            app.manage(ivy::IvyHost::new(
                &directory,
                std::sync::Arc::new(move |snapshot| {
                    let _ = handle.emit_to("main", ivy::contracts::IVY_EVENT, snapshot);
                }),
            ));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<ivy::IvyHost>()
            {
                host.shutdown();
            }
        });
    #[cfg(feature = "native-smoke")]
    let builder = smoke::configure(builder);
    #[cfg(not(feature = "native-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::shell_status,
        app_info::app_info,
        ivy::ivy_connect,
        ivy::ivy_snapshot,
        ivy::ivy_submit,
        ivy::ivy_cancel,
        ivy::ivy_reconcile,
        ivy::ivy_disconnect
    ]);
    builder
        .build(tauri::generate_context!())
        .expect("Stellar desktop failed to launch")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<ivy::IvyHost>()
            {
                host.shutdown();
            }
        });
}
