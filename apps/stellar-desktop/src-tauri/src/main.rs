#![deny(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_info;
mod cleanup;
mod commands;
mod contracts;
mod ivy;
mod media;
mod music;
mod owned_child;
#[cfg(feature = "recognition-smoke")]
mod recognition_smoke;
mod reflex;
mod shell;
#[cfg(all(feature = "native-smoke", not(feature = "recognition-smoke")))]
mod smoke;
mod speech;
mod telemetry;
mod volume_ducking;

fn main() {
    use tauri::{Emitter, Manager};
    debug_assert_eq!(ivy::contracts::IVY_COMMANDS.len(), 11);
    debug_assert_eq!(
        ivy::contracts::WORKSPACE_REPLY_COMMAND,
        "workspace_tool_reply"
    );
    let navigation = tauri::plugin::Builder::<tauri::Wry>::new("local-navigation")
        .on_navigation(|view, url| {
            if view.label().starts_with("workspace-browser-") {
                return media::network::url(url.as_str()).is_ok();
            }
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        })
        .build();
    let builder = tauri::Builder::default()
        .plugin(navigation)
        .setup(|app| {
            let music_handle = app.handle().clone();
            app.manage(music::MusicHost::new(std::sync::Arc::new(
                move |snapshot| {
                    let _ = music_handle.emit_to("main", music::MUSIC_EVENT, snapshot);
                },
            )));
            app.manage(cleanup::CleanupHost::default());
            app.manage(reflex::ReflexHost::default());
            app.manage(std::sync::Arc::new(reflex::MediaHost::default()));
            app.manage(media::MediaHost::default());
            let handle = app.handle().clone();
            #[cfg(not(feature = "native-smoke"))]
            let directory = app.path().app_local_data_dir()?.join("ivy");
            #[cfg(feature = "native-smoke")]
            let directory =
                std::env::temp_dir().join(format!("stellar-ivy-smoke-{}", std::process::id()));
            let ivy_host = ivy::IvyHost::new(
                &directory,
                std::sync::Arc::new(move |snapshot| {
                    let _ = handle.emit_to("main", ivy::contracts::IVY_EVENT, snapshot);
                }),
            );
            let handle = app.handle().clone();
            ivy_host.set_workspace_publisher(std::sync::Arc::new(move |request| {
                handle
                    .emit_to("main", ivy::contracts::WORKSPACE_EVENT, request)
                    .is_ok()
            }));
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                ivy_host.set_workspace_capture(std::sync::Arc::new(move |operation| {
                    ivy::capture_workspace_operation(&handle, operation)
                }));
            }
            app.manage(ivy_host);
            let handle = app.handle().clone();
            #[cfg(not(feature = "recognition-smoke"))]
            let speech_directory = app.path().app_local_data_dir()?.join("speech");
            #[cfg(feature = "recognition-smoke")]
            let speech_directory = std::env::temp_dir()
                .join(format!("stellar-recognition-smoke-{}", std::process::id()));
            let speech_host = speech::SpeechHost::new(
                speech_directory,
                std::sync::Arc::new(move |snapshot| {
                    let _ = handle.emit_to("main", speech::contracts::SPEECH_EVENT, snapshot);
                }),
            );
            app.manage(volume_ducking::VolumeDucking::new(
                speech_host.audio_process(),
            ));
            app.manage(speech_host);
            #[cfg(feature = "recognition-smoke")]
            recognition_smoke::create_window(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<volume_ducking::VolumeDucking>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<std::sync::Arc<reflex::MediaHost>>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<reflex::ReflexHost>()
            {
                host.shutdown();
            }
            if (matches!(event, tauri::WindowEvent::Destroyed)
                || (matches!(event, tauri::WindowEvent::Resized(_))
                    && window.is_minimized().unwrap_or(false)))
                && let Some(host) = window.try_state::<music::MusicHost>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<ivy::IvyHost>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<cleanup::CleanupHost>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(host) = window.try_state::<speech::SpeechHost>()
            {
                let _ = host.shutdown();
            }
        });
    #[cfg(all(feature = "native-smoke", not(feature = "recognition-smoke")))]
    let builder = smoke::configure(builder);
    #[cfg(feature = "recognition-smoke")]
    let builder = recognition_smoke::configure(builder);
    #[cfg(not(feature = "native-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::shell_status,
        music::music_set_enabled,
        media::workspace_browser,
        media::workspace_image,
        app_info::app_info,
        ivy::ivy_connect,
        ivy::ivy_snapshot,
        ivy::ivy_submit,
        ivy::ivy_cancel,
        ivy::ivy_reconcile,
        ivy::ivy_disconnect,
        ivy::ivy_select_session,
        ivy::ivy_clear_conversation,
        ivy::ivy_new_session,
        ivy::ivy_reload_mcp,
        ivy::ivy_question_reply,
        ivy::workspace_tool_reply,
        speech::speech_transcribe,
        speech::speech_collect,
        speech::speech_keywords,
        speech::speech_speak,
        speech::speech_stop,
        speech::speech_snapshot,
        speech::speech_set_ducking,
        cleanup::cleanup_refine,
        reflex::reflex_infer,
        reflex::reflex_route,
        reflex::reflex_prepare,
        reflex::reflex_status,
        reflex::reflex_set_enabled,
        reflex::reflex_cancel,
        reflex::reflex_media_snapshot,
        reflex::reflex_media_execute,
        telemetry::telemetry_snapshot
    ]);
    builder
        .build(tauri::generate_context!())
        .expect("Stellar desktop failed to launch")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<volume_ducking::VolumeDucking>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<std::sync::Arc<reflex::MediaHost>>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<reflex::ReflexHost>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<music::MusicHost>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<ivy::IvyHost>()
            {
                host.shutdown();
            }
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(host) = app.try_state::<cleanup::CleanupHost>()
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
