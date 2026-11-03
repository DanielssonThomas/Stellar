use super::{
    contracts::SpeechError,
    frames,
    process::{self, ChildSlot},
    state::Operation,
};
use std::{
    process::Command,
    sync::{Arc, Mutex, mpsc},
    time::Instant,
};

type Transport = process::PersistentTransport;

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
    pub fn stop(&self) -> Result<(), SpeechError> {
        process::stop(&self.child)?;
        if let Ok(mut transport) = self.transport.try_lock() {
            *transport = None;
        }
        Ok(())
    }

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

fn start(command: Command) -> Result<(process::Child, Transport), SpeechError> {
    process::start_persistent(command, 8)
}

impl Drop for WarmVoice {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(all(test, windows))]
#[path = "warm_tests.rs"]
mod tests;
