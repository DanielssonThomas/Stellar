#![forbid(unsafe_code)]
#[path = "src/app_info/command_name.rs"]
mod command_name;
#[path = "src/ivy/command_names.rs"]
mod ivy_names;
#[path = "src/speech/command_names.rs"]
mod speech_names;

fn main() {
    const COMMANDS: &[&str] = &[
        "shell_status",
        command_name::APP_INFO_COMMAND,
        "smoke_result",
        ivy_names::IVY_COMMANDS[0],
        ivy_names::IVY_COMMANDS[1],
        ivy_names::IVY_COMMANDS[2],
        ivy_names::IVY_COMMANDS[3],
        ivy_names::IVY_COMMANDS[4],
        ivy_names::IVY_COMMANDS[5],
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
