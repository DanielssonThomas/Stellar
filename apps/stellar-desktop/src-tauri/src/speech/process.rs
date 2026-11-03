use super::contracts::SpeechError;
pub(super) use super::owned_child::OwnedChild as Child;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex, mpsc},
};

pub type ChildSlot = Arc<Mutex<Option<Child>>>;
pub type Frames = mpsc::Receiver<Result<Value, SpeechError>>;

pub(super) struct PersistentTransport {
    pub(super) input: mpsc::SyncSender<Vec<u8>>,
    pub(super) frames: Frames,
}

pub(super) fn start_persistent(
    mut command: Command,
    capacity: usize,
) -> Result<(Child, PersistentTransport), SpeechError> {
    configure(&mut command);
    let mut child = Child::spawn(command).map_err(|_| SpeechError::Unavailable)?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(SpeechError::Unavailable);
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(SpeechError::Unavailable);
    };
    let (send, frames) = mpsc::sync_channel(capacity);
    let (input, pending) = mpsc::sync_channel::<Vec<u8>>(1);
    let errors = send.clone();
    std::thread::spawn(move || {
        while let Ok(payload) = pending.recv() {
            if stdin
                .write_all(&payload)
                .and_then(|_| stdin.flush())
                .is_err()
            {
                let _ = errors.send(Err(SpeechError::Unavailable));
                break;
            }
        }
    });
    read_frames(stdout, send);
    Ok((child, PersistentTransport { input, frames }))
}

pub(super) fn recognition_command(mode: &str) -> Command {
    let mut command = Command::new(r"D:\Hermes\profiles\ivy\recognition\.venv\Scripts\python.exe");
    command.args([
        "-I",
        "-u",
        "-c",
        include_str!("recognition_worker.py"),
        mode,
    ]);
    sanitize(&mut command);
    command
}

fn sanitize(command: &mut Command) {
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
}

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
    spawn(command(mode)?, slot, payload)
}

pub(super) fn command(mode: &str) -> Result<Command, SpeechError> {
    let python = if mode == "transcribe" {
        crate::ivy::runtime::python().map_err(|_| SpeechError::Unavailable)?
    } else {
        std::path::PathBuf::from(r"D:\Hermes\profiles\ivy\voice\.venv\Scripts\python.exe")
    };
    let mut command = Command::new(python);
    command.args(["-I", "-u", "-c", include_str!("speech_worker.py"), mode]);
    sanitize(&mut command);
    Ok(command)
}

pub(super) fn configure(command: &mut Command) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

pub(super) fn spawn(
    mut command: Command,
    slot: &ChildSlot,
    payload: Vec<u8>,
) -> Result<Frames, SpeechError> {
    configure(&mut command);
    let mut child = Child::spawn(command).map_err(|_| SpeechError::Unavailable)?;
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
    read_frames(output, send);
    Ok(receive)
}

pub(super) fn read_frames(
    output: impl Read + Send + 'static,
    send: mpsc::SyncSender<Result<Value, SpeechError>>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = vec![];
            let result = match reader.by_ref().take(16_385).read_until(b'\n', &mut line) {
                Ok(0) => {
                    let _ = send.send(Err(SpeechError::Unavailable));
                    break;
                }
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
}

pub fn payload(value: Value) -> Result<Vec<u8>, SpeechError> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| SpeechError::MalformedRequest)?;
    bytes.push(b'\n');
    if bytes.len() > 3 * 1024 * 1024 {
        return Err(SpeechError::MalformedRequest);
    }
    Ok(bytes)
}
