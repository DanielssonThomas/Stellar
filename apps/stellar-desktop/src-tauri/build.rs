#![forbid(unsafe_code)]
#[path = "src/cleanup/command_name.rs"]
mod cleanup_name;
#[path = "src/app_info/command_name.rs"]
mod command_name;
#[path = "src/ivy/command_names.rs"]
mod ivy_names;
#[path = "src/speech/command_names.rs"]
mod speech_names;

fn main() {
    const COMMANDS: &[&str] = &[
        "shell_status",
        cleanup_name::CLEANUP_COMMAND,
        command_name::APP_INFO_COMMAND,
        "smoke_result",
        "smoke_hold_ivy",
        ivy_names::IVY_COMMANDS[0],
        ivy_names::IVY_COMMANDS[1],
        ivy_names::IVY_COMMANDS[2],
        ivy_names::IVY_COMMANDS[3],
        ivy_names::IVY_COMMANDS[4],
        ivy_names::IVY_COMMANDS[5],
        ivy_names::IVY_COMMANDS[6],
        ivy_names::IVY_COMMANDS[7],
        speech_names::SPEECH_COMMANDS[0],
        speech_names::SPEECH_COMMANDS[1],
        speech_names::SPEECH_COMMANDS[2],
        speech_names::SPEECH_COMMANDS[3],
    ];
    let _ = ivy_names::IVY_EVENT;
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("Invalid desktop configuration");
}
