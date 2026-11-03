use super::{
    contracts::SpeechError,
    frames,
    process::{self, ChildSlot, Frames},
    state::Operation,
};
use std::{
    io::Write,
    process::Command,
    sync::{Arc, Mutex, mpsc},
    time::Instant,
};

struct Transport {
    input: mpsc::SyncSender<Vec<u8>>,
    frames: Frames,
}

/// One serial speech operation owns the transport; stop can reap its child without this lock.
pub(super) struct WarmVoice {
    pub child: ChildSlot,
    transport: Mutex<Option<Transport>>,
}

impl Default for WarmVoice {
    fn default() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            transport: Mutex::new(None),
        }
    }
}

impl WarmVoice {
    pub fn run(
        &self,
        operation: &Operation,
        payload: Vec<u8>,
        deadline: Instant,
        on_speaking: impl FnMut() -> Result<(), SpeechError>,
        on_timing: impl FnMut(super::contracts::SpeechTiming) -> Result<(), SpeechError>,
    ) -> Result<String, SpeechError> {
        self.run_using(operation, payload, deadline, on_speaking, on_timing, || {
            process::command("speak")
        })
    }

    fn run_using(
        &self,
        operation: &Operation,
        payload: Vec<u8>,
        deadline: Instant,
        on_speaking: impl FnMut() -> Result<(), SpeechError>,
        on_timing: impl FnMut(super::contracts::SpeechTiming) -> Result<(), SpeechError>,
        command: impl FnOnce() -> Result<Command, SpeechError>,
    ) -> Result<String, SpeechError> {
        let mut slot = self
            .transport
            .lock()
            .map_err(|_| SpeechError::Unavailable)?;
        // Serialize cancellation with launch so stop never misses a newly spawned child.
        {
            let mut child = self.child.lock().map_err(|_| SpeechError::Unavailable)?;
            if operation
                .cancelled
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(SpeechError::Cancelled);
            }
            let running = match child.as_mut() {
                Some(child) => child
                    .try_wait()
                    .map_err(|_| SpeechError::Unavailable)?
                    .is_none(),
                None => false,
            };
            if !running {
                *child = None;
                let (process, channel) = start(command()?)?;
                *child = Some(process);
                *slot = Some(channel);
            }
        }
        let transport = slot.as_ref().ok_or(SpeechError::Unavailable)?;
        match transport.frames.try_recv() {
            Err(mpsc::TryRecvError::Empty) => {}
            _ => return Err(SpeechError::Protocol),
        }
        transport
            .input
            .try_send(payload)
            .map_err(|_| SpeechError::Unavailable)?;
        let result = frames::collect(
            &operation.cancelled,
            "speak",
            &transport.frames,
            deadline,
            on_speaking,
            on_timing,
        );
        if result.is_err() {
            process::stop(&self.child)?;
            *slot = None;
        }
        result
    }
}

fn start(mut command: Command) -> Result<(std::process::Child, Transport), SpeechError> {
    process::configure(&mut command);
    let mut child = command.spawn().map_err(|_| SpeechError::Unavailable)?;
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
    let (send, frames) = mpsc::sync_channel(8);
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
    process::read_frames(stdout, send);
    Ok((child, Transport { input, frames }))
}

impl Drop for WarmVoice {
    fn drop(&mut self) {
        let _ = process::stop(&self.child);
    }
}

#[cfg(all(test, windows))]
#[path = "warm_tests.rs"]
mod tests;
