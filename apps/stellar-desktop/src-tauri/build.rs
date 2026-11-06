#![forbid(unsafe_code)]
#[path = "src/cleanup/command_name.rs"]
mod cleanup_name;
#[path = "src/app_info/command_name.rs"]
mod command_name;
#[path = "src/ivy/command_names.rs"]
mod ivy_names;
#[allow(dead_code)]
#[path = "src/music/command_names.rs"]
mod music;
#[path = "src/speech/command_names.rs"]
mod speech_names;
#[path = "src/telemetry/command_name.rs"]
mod telemetry_name;

fn main() {
    const COMMANDS: &[&str] = &[
        "shell_status",
        "ivy_inspect",
        "reflex_infer",
        "reflex_route",
        "reflex_prepare",
        "reflex_status",
        "reflex_set_enabled",
        "reflex_cancel",
        "reflex_media_snapshot",
        "reflex_media_execute",
        music::MUSIC_COMMAND,
        "workspace_browser",
        "workspace_image",
        cleanup_name::CLEANUP_COMMAND,
        command_name::APP_INFO_COMMAND,
        "smoke_result",
        "smoke_media_probe",
        telemetry_name::TELEMETRY_COMMAND,
        "smoke_hold_ivy",
        "smoke_capture_window",
        "recognition_result",
        ivy_names::IVY_COMMANDS[0],
        ivy_names::IVY_COMMANDS[1],
        ivy_names::IVY_COMMANDS[2],
        ivy_names::IVY_COMMANDS[3],
        ivy_names::IVY_COMMANDS[4],
        ivy_names::IVY_COMMANDS[5],
        ivy_names::IVY_COMMANDS[6],
        ivy_names::IVY_COMMANDS[7],
        ivy_names::IVY_COMMANDS[8],
        ivy_names::IVY_COMMANDS[9],
        ivy_names::IVY_COMMANDS[10],
        ivy_names::WORKSPACE_REPLY_COMMAND,
        speech_names::SPEECH_COMMANDS[0],
        speech_names::SPEECH_COMMANDS[1],
        speech_names::SPEECH_COMMANDS[2],
        speech_names::SPEECH_COMMANDS[3],
        speech_names::SPEECH_COMMANDS[4],
        speech_names::SPEECH_COMMANDS[5],
        speech_names::SPEECH_COMMANDS[6],
    ];
    let _ = ivy_names::IVY_EVENT;
    let _ = ivy_names::WORKSPACE_EVENT;
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("Invalid desktop configuration");
}
