use super::contracts::IvyErrorCode;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

pub type OwnedChild = Arc<Mutex<Option<Child>>>;
pub fn request_line(sequence: u64, method: &str, params: &Value) -> Result<Vec<u8>, IvyErrorCode> {
    let mut line = serde_json::to_vec(&json!({"id":sequence,"method":method,"params":params}))
        .map_err(|_| IvyErrorCode::Protocol)?;
    line.push(b'\n');
    if line.len() > 16_384 {
        return Err(IvyErrorCode::MalformedRequest);
    }
    Ok(line)
}
pub struct Broker {
    input: ChildStdin,
    frames: Receiver<Result<Value, IvyErrorCode>>,
    child: OwnedChild,
    sequence: u64,
    deadline: Duration,
}

pub fn stop(child: &OwnedChild) {
    if let Ok(mut slot) = child.lock()
        && let Some(mut process) = slot.take()
    {
        let _ = process.kill();
        let _ = process.wait();
    }
}

impl Broker {
    pub fn launch(child: OwnedChild) -> Result<Self, IvyErrorCode> {
        let mut command = Command::new(super::runtime::python()?);
        command
            .args(["-I", "-u", "-c", include_str!("ivy_bridge.py")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("HERMES_TUI_GATEWAY_URL")
            .env_remove("PYTHONPATH");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Self::spawn(command, child)
    }

    pub(super) fn spawn(mut command: Command, child: OwnedChild) -> Result<Self, IvyErrorCode> {
        let mut process = command.spawn().map_err(|_| IvyErrorCode::Unavailable)?;
        let input = process.stdin.take().ok_or(IvyErrorCode::Unavailable)?;
        let output = process.stdout.take().ok_or(IvyErrorCode::Unavailable)?;
        *child.lock().map_err(|_| IvyErrorCode::Unavailable)? = Some(process);
        let (sender, frames) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = vec![];
                let count = reader.by_ref().take(65_537).read_until(b'\n', &mut line);
                let frame = match count {
                    Ok(0) => break,
                    Ok(n) if n <= 65_536 && line.last() == Some(&b'\n') => {
                        serde_json::from_slice(&line).map_err(|_| IvyErrorCode::Protocol)
                    }
                    _ => Err(IvyErrorCode::Protocol),
                };
                let failed = frame.is_err();
                if sender.try_send(frame).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            input,
            frames,
            child,
            sequence: 0,
            deadline: Duration::from_secs(18),
        })
    }

    pub fn poll(&self) -> Result<Option<Value>, IvyErrorCode> {
        match self.frames.try_recv() {
            Ok(frame) => frame.map(Some),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(IvyErrorCode::Unavailable),
        }
    }

    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        events: &mut Vec<Value>,
    ) -> Result<Value, IvyErrorCode> {
        self.sequence = self.sequence.checked_add(1).ok_or(IvyErrorCode::Protocol)?;
        let line = request_line(self.sequence, method, &params)?;
        self.input
            .write_all(&line)
            .and_then(|_| self.input.flush())
            .map_err(|_| IvyErrorCode::Unavailable)?;
        let deadline = Instant::now() + self.deadline;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .frames
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => IvyErrorCode::Timeout,
                    mpsc::RecvTimeoutError::Disconnected => IvyErrorCode::Unavailable,
                })??;
            if frame.get("id").and_then(Value::as_u64) == Some(self.sequence) {
                if frame.get("error").is_some() {
                    return Err(IvyErrorCode::Uncertain);
                }
                return frame.get("result").cloned().ok_or(IvyErrorCode::Protocol);
            }
            if frame.get("id").is_some() || events.len() >= 32 {
                return Err(IvyErrorCode::Protocol);
            }
            events.push(frame);
        }
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        stop(&self.child);
    }
}

#[cfg(all(test, windows))]
#[path = "process_tests.rs"]
mod tests;
