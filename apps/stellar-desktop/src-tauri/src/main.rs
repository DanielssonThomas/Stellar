#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod contracts;
mod shell;
#[cfg(feature = "native-smoke")]
mod smoke;

fn main() {
    let navigation = tauri::plugin::Builder::<tauri::Wry>::new("local-navigation")
        .on_navigation(|_, url| {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        })
        .build();
    let builder = tauri::Builder::default().plugin(navigation);
    #[cfg(feature = "native-smoke")]
    let builder = smoke::configure(builder);
    #[cfg(not(feature = "native-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![commands::shell_status]);
    builder
        .run(tauri::generate_context!())
        .expect("Stellar desktop failed to launch");
}
