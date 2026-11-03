use super::{contracts::SpeechError, process};
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

struct Session {
    epoch: u64,
    transport: process::PersistentTransport,
}

pub(super) struct WarmWorker {
    mode: &'static str,
    child: process::ChildSlot,
    session: Mutex<Option<Session>>,
    epoch: AtomicU64,
    #[cfg(test)]
    command: Option<fn() -> std::process::Command>,
}

impl WarmWorker {
    pub(super) fn new(mode: &'static str) -> Self {
        Self {
            mode,
            child: Arc::new(Mutex::new(None)),
            session: Mutex::new(None),
            epoch: AtomicU64::new(0),
            #[cfg(test)]
            command: None,
        }
    }

    pub(super) fn ticket(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub(super) fn stop(&self) -> Result<(), SpeechError> {
        let mut child = self.child.lock().map_err(|_| SpeechError::Unavailable)?;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(owned) = child.as_mut() {
            let _ = owned.kill();
            owned.wait().map_err(|_| SpeechError::Unavailable)?;
            *child = None;
        }
        drop(child);
        // In-flight requests own their transport until cancellation settles.
        if let Ok(mut session) = self.session.try_lock() {
            *session = None;
        }
        Ok(())
    }

    fn launch(&self, epoch: u64) -> Result<Session, SpeechError> {
        let mut owned = self.child.lock().map_err(|_| SpeechError::Unavailable)?;
        if self.ticket() != epoch {
            return Err(SpeechError::Cancelled);
        }
        if owned.is_some() {
            return Err(SpeechError::Unavailable);
        }
        let command = process::recognition_command(self.mode);
        #[cfg(test)]
        let command = self.command.map_or(command, |factory| factory());
        let (child, transport) = process::start_persistent(command, 2)?;
        *owned = Some(child);
        Ok(Session { epoch, transport })
    }

    pub(super) fn request(
        &self,
        payload: Vec<u8>,
        epoch: u64,
        timeout: Duration,
    ) -> Result<Value, SpeechError> {
        let mut session = self.session.try_lock().map_err(|_| SpeechError::Busy)?;
        if epoch != self.ticket() {
            return Err(SpeechError::Cancelled);
        }
        if session
            .as_ref()
            .is_some_and(|session| session.epoch != epoch)
        {
            *session = None;
        }
        let result = (|| {
            if session.is_none() {
                *session = Some(self.launch(epoch)?);
            }
            let active = session.as_ref().ok_or(SpeechError::Unavailable)?;
            if active.transport.frames.try_recv().is_ok() {
                return Err(SpeechError::Protocol);
            }
            active
                .transport
                .input
                .try_send(payload)
                .map_err(|_| SpeechError::Unavailable)?;
            let deadline = Instant::now() + timeout;
            loop {
                if epoch != self.ticket() {
                    return Err(SpeechError::Cancelled);
                }
                if Instant::now() >= deadline {
                    return Err(SpeechError::Timeout);
                }
                match active
                    .transport
                    .frames
                    .recv_timeout(Duration::from_millis(20))
                {
                    Ok(Ok(frame)) => {
                        if let Some(error) = frame.get("error") {
                            return Err(match error.as_str() {
                                Some("model_missing") => SpeechError::ModelMissing,
                                Some("protocol") => SpeechError::Protocol,
                                _ => SpeechError::Unavailable,
                            });
                        }
                        return Ok(frame);
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => return Err(SpeechError::Unavailable),
                }
            }
        })();
        let result = if epoch != self.ticket() {
            Err(SpeechError::Cancelled)
        } else {
            result
        };
        if result.is_err() {
            if epoch == self.ticket() {
                self.stop()?;
            }
            *session = None;
        }
        result
    }
}

impl Drop for WarmWorker {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
#[path = "warm_worker_tests.rs"]
mod tests;
