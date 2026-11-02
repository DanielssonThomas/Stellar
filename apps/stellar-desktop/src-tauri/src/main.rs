#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_info;
mod cleanup;
mod commands;
mod contracts;
mod ivy;
mod shell;
#[cfg(feature = "native-smoke")]
mod smoke;
mod speech;

fn main() {
    use tauri::{Emitter, Manager};
    debug_assert_eq!(ivy::contracts::IVY_COMMANDS.len(), 8);
    let navigation = tauri::plugin::Builder::<tauri::Wry>::new("local-navigation")
        .on_navigation(|_, url| {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        })
        .build();
    let builder = tauri::Builder::default()
        .plugin(navigation)
        .setup(|app| {
            app.manage(cleanup::CleanupHost::default());
            let handle = app.handle().clone();
            #[cfg(not(feature = "native-smoke"))]
            let directory = app.path().app_local_data_dir()?.join("ivy");
            #[cfg(feature = "native-smoke")]
            let directory =
                std::env::temp_dir().join(format!("stellar-ivy-smoke-{}", std::process::id()));
            app.manage(ivy::IvyHost::new(
                &directory,
                std::sync::Arc::new(move |snapshot| {
                    let _ = handle.emit_to("main", ivy::contracts::IVY_EVENT, snapshot);
                }),
            ));
            let handle = app.handle().clone();
            app.manage(speech::SpeechHost::new(
                app.path().app_local_data_dir()?.join("speech"),
                std::sync::Arc::new(move |snapshot| {
                    let _ = handle.emit_to("main", speech::contracts::SPEECH_EVENT, snapshot);
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
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<speech::SpeechHost>()
            {
                let _ = host.shutdown();
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
        ivy::ivy_disconnect,
        ivy::ivy_select_session,
        ivy::ivy_clear_conversation,
        speech::speech_transcribe,
        speech::speech_speak,
        speech::speech_stop,
        speech::speech_snapshot,
        cleanup::cleanup_refine
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
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<speech::SpeechHost>()
            {
                let _ = host.shutdown();
            }
        });
}
