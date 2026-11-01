#![forbid(unsafe_code)]
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod commands;
mod contracts;
mod domain;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::probe_round_trip])
        .run(tauri::generate_context!())
        .expect("Desktop feasibility probe failed to launch");
}
