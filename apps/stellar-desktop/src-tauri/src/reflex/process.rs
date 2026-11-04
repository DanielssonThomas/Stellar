use crate::owned_child::OwnedChild;
use std::process::{Command, Stdio};

pub(super) fn launch(key: &str, current: &dyn Fn() -> bool) -> Option<OwnedChild> {
    // Only explicitly configured, already installed files. Never download or reuse Hermes' GPU server.
    let (model, binary, layers) = super::setup::configuration()?;
    if !current() {
        return None;
    }
    // Refuse an occupied endpoint rather than borrowing an unrelated local process.
    let socket = std::net::TcpListener::bind("127.0.0.1:18439").ok()?;
    let mut command = Command::new(binary);
    command
        .arg("-m")
        .arg(model)
        .args([
            "--alias",
            "ivy-reflex",
            "--host",
            "127.0.0.1",
            "--port",
            "18439",
            "-c",
            "4096",
            "-np",
            "1",
            "-t",
            "4",
            "-tb",
            "4",
            "--prio",
            "-1",
            "-ngl",
            &layers.to_string(),
            "--jinja",
            "--reasoning",
            "off",
            "--chat-template-kwargs",
            "{\"enable_thinking\":false}",
            "--no-webui",
            "--api-key",
            key,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if layers == 0 {
        command.args(["--device", "none", "--no-kv-offload"]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000);
    }
    drop(socket);
    OwnedChild::spawn(command).ok()
}
