use super::contracts::{ReflexMediaRequest, ReflexMediaResult, ReflexMediaState};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

const PROFILE: &str = "D:/Hermes/profiles/ivy";

#[derive(Serialize)]
struct Receipt<'a> {
    version: u8,
    captured_unix_ms: u64,
    input_id: &'a str,
    action: &'a super::contracts::ReflexMediaAction,
    outcome: &'a ReflexMediaResult,
    // This is dispatch context, not evidence that the user selected or likes the title.
    context_title: Option<String>,
    player: Option<String>,
}

fn write_receipt(
    folder: &Path,
    r: &ReflexMediaRequest,
    state: &ReflexMediaState,
    outcome: &ReflexMediaResult,
) -> std::io::Result<()> {
    if fs::read(folder.join("enabled")).ok().as_deref() != Some(b"ivy-notebook-reflex-v1\n") {
        return Ok(());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_millis() as u64;
    let config_path = folder
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing notebook"))?
        .join("config.json");
    let cfg: serde_json::Value = serde_json::from_slice(&fs::read(config_path)?)?;
    if cfg["automatic_capture"].as_bool() != Some(true)
        || cfg["paused_until"].as_f64().unwrap_or(f64::INFINITY) > timestamp as f64 / 1000.0
    {
        return Ok(());
    }
    let spool = folder.join("reflex");
    fs::create_dir_all(&spool)?;
    // Fixed capacity: queue recovery/weekly review drains these; never evict unconsumed receipts.
    if fs::read_dir(&spool)?.take(257).count() >= 256 {
        return Err(std::io::Error::other("Notebook receipt capacity reached"));
    }
    let id = format!("{:x}", Sha256::digest(r.input_id.as_bytes()));
    let destination = spool.join(format!("{id}.json"));
    if destination.exists() {
        return Ok(());
    }
    let data = serde_json::to_vec(&Receipt {
        version: 1,
        captured_unix_ms: timestamp,
        input_id: &r.input_id,
        action: &r.action,
        outcome,
        context_title: state.title.as_ref().map(|s| s.chars().take(200).collect()),
        player: state.player.as_ref().map(|s| s.chars().take(100).collect()),
    })?;
    let temp = spool.join(format!("{id}.tmp"));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    file.write_all(&data)?;
    file.sync_all()?;
    fs::rename(temp, destination)
}

fn persist_and_wake(
    folder: &Path,
    r: &ReflexMediaRequest,
    state: &ReflexMediaState,
    outcome: &ReflexMediaResult,
    wake: impl FnOnce(),
) {
    if write_receipt(folder, r, state, outcome).is_err() {
        eprintln!("Ivy notebook receipt deferred: local storage unavailable");
    }
    // A full or temporarily unavailable spool still needs its existing worker to recover.
    if folder.join("enabled").is_file() {
        wake();
    }
}

pub fn record(r: &ReflexMediaRequest, state: &ReflexMediaState, outcome: &ReflexMediaResult) {
    let (r, state, outcome) = (r.clone(), state.clone(), outcome.clone());
    // One bounded receipt for an explicit dispatch; no snapshot subscription or playback polling.
    let _ = std::thread::Builder::new()
        .name("ivy-notebook-receipt".into())
        .spawn(move || {
            let folder = Path::new(PROFILE).join("notebook/private");
            persist_and_wake(&folder, &r, &state, &outcome, wake_worker);
        });
}

fn wake_worker() {
    let mut command =
        std::process::Command::new("D:/Hermes/tools/python-3.14.9+20261021-win32-x64/python.exe");
    command
        .arg(Path::new(PROFILE).join("notebook/notebook.py"))
        .arg("drain")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    // Reap the short-lived worker in this detached receipt thread.
    let _ = command.status();
}

#[cfg(test)]
#[path = "notebook_tests.rs"]
mod tests;
