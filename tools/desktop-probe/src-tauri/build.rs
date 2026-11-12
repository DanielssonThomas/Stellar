#![forbid(unsafe_code)]

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["probe_round_trip"]));
    tauri_build::try_build(attributes).expect("Tauri probe configuration is invalid");
}
