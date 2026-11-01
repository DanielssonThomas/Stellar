#![forbid(unsafe_code)]

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["shell_status", "smoke_result"]));
    tauri_build::try_build(attributes).expect("Invalid desktop configuration");
}
