#![forbid(unsafe_code)]
#[path = "src/app_info/command_name.rs"]
mod command_name;

fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "shell_status",
            command_name::APP_INFO_COMMAND,
            "smoke_result",
        ]));
    tauri_build::try_build(attributes).expect("Invalid desktop configuration");
}
