use super::contracts::SpeechError;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
};

pub type ChildSlot = Arc<Mutex<Option<Child>>>;
pub type Frames = mpsc::Receiver<Result<Value, SpeechError>>;

pub fn stop(slot: &ChildSlot) -> Result<(), SpeechError> {
    let mut owned = slot.lock().map_err(|_| SpeechError::Unavailable)?;
    if let Some(child) = owned.as_mut() {
        let _ = child.kill();
        child.wait().map_err(|_| SpeechError::Unavailable)?;
        *owned = None;
    }
    Ok(())
}

pub fn launch(mode: &str, slot: &ChildSlot, payload: Vec<u8>) -> Result<Frames, SpeechError> {
    let python = if mode == "transcribe" {
        crate::ivy::runtime::python().map_err(|_| SpeechError::Unavailable)?
    } else {
        std::path::PathBuf::from(r"D:\Hermes\profiles\ivy\voice\.venv\Scripts\python.exe")
    };
    let mut command = Command::new(python);
    command.args(["-I", "-u", "-c", include_str!("speech_worker.py"), mode]);
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_uppercase();
        if [
            "KEY",
            "TOKEN",
            "SECRET",
            "PASSWORD",
            "AUTH",
            "COOKIE",
            "PYTHONPATH",
        ]
        .iter()
        .any(|part| upper.contains(part))
        {
            command.env_remove(key);
        }
    }
    spawn(command, slot, payload)
}

pub(super) fn spawn(
    mut command: Command,
    slot: &ChildSlot,
    payload: Vec<u8>,
) -> Result<Frames, SpeechError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| SpeechError::Unavailable)?;
    let input = child.stdin.take();
    let output = child.stdout.take();
    *slot.lock().map_err(|_| SpeechError::Unavailable)? = Some(child);
    let mut input = input.ok_or(SpeechError::Unavailable)?;
    let output = output.ok_or(SpeechError::Unavailable)?;
    let (send, receive) = mpsc::sync_channel(8);
    let writer = send.clone();
    std::thread::spawn(move || {
        if input
            .write_all(&payload)
            .and_then(|_| input.flush())
            .is_err()
        {
            let _ = writer.send(Err(SpeechError::Unavailable));
        }
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = vec![];
            let result = match reader.by_ref().take(16_385).read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(size) if size <= 16_384 && line.ends_with(b"\n") => {
                    serde_json::from_slice(&line).map_err(|_| SpeechError::Protocol)
                }
                _ => Err(SpeechError::Protocol),
            };
            let failed = result.is_err();
            if send.send(result).is_err() || failed {
                break;
            }
        }
    });
    Ok(receive)
}

pub fn payload(value: Value) -> Result<Vec<u8>, SpeechError> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| SpeechError::MalformedRequest)?;
    bytes.push(b'\n');
    if bytes.len() > 3 * 1024 * 1024 {
        return Err(SpeechError::MalformedRequest);
    }
    Ok(bytes)
}
