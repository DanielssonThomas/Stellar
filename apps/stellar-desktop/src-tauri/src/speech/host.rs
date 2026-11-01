use super::{contracts::*, process, scratch::Scratch, state::*, validation};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct SpeechHost {
    inner: Arc<Inner>,
}

impl SpeechHost {
    pub fn new(scratch: PathBuf, publish: Publisher) -> Self {
        Self {
            inner: Arc::new(Inner {
                view: Mutex::new(View {
                    snapshot: SpeechSnapshot::default(),
                    active: None,
                    serial: 0,
                    closed: false,
                    epoch: 0,
                }),
                publish,
                scratch,
                #[cfg(test)]
                settlement_gate: Mutex::new(None),
            }),
        }
    }
    pub fn snapshot(&self) -> Result<SpeechSnapshot, SpeechError> {
        Ok(self
            .inner
            .view
            .lock()
            .map_err(|_| SpeechError::Unavailable)?
            .snapshot
            .clone())
    }
    fn reserve(
        &self,
        id: String,
        epoch: &str,
        state: SpeechState,
    ) -> Result<Arc<Operation>, SpeechError> {
        let epoch = validation::epoch(epoch)?;
        let (operation, snapshot) = {
            let mut view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if view.closed {
                return Err(SpeechError::Unavailable);
            }
            if epoch < view.epoch {
                return Err(SpeechError::Cancelled);
            }
            if epoch > view.epoch {
                return Err(SpeechError::MalformedRequest);
            }
            if view.active.is_some() {
                return Err(SpeechError::Busy);
            }
            view.serial = view.serial.checked_add(1).ok_or(SpeechError::Unavailable)?;
            let scratch = if state == SpeechState::Synthesizing {
                Some(Scratch::new(&self.inner.scratch, view.serial)?)
            } else {
                None
            };
            let operation = Arc::new(Operation {
                serial: view.serial,
                child: Arc::new(Mutex::new(None)),
                cancelled: AtomicBool::new(false),
                scratch,
            });
            view.active = Some(operation.clone());
            view.snapshot.operation_id = Some(id);
            view.snapshot.state = state;
            view.snapshot.error = None;
            (operation, advance(&mut view))
        };
        (self.inner.publish)(snapshot);
        Ok(operation)
    }
    pub fn transcribe(
        &self,
        request: SpeechTranscribeRequest,
    ) -> Result<std::sync::mpsc::Receiver<Result<SpeechTranscript, SpeechError>>, SpeechError> {
        validation::transcribe(&request)?;
        let payload =
            process::payload(json!({"pcm":request.pcm,"sample_rate_hz":request.sample_rate_hz}))?;
        let operation = self.reserve(
            request.utterance_id.clone(),
            &request.epoch,
            SpeechState::Transcribing,
        )?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let host = self.clone();
        std::thread::spawn(move || {
            let result = host.execute(&operation, "transcribe", payload, Duration::from_secs(60));
            let result = host
                .settle(&operation, result)
                .map(|text| SpeechTranscript {
                    version: 1,
                    utterance_id: request.utterance_id,
                    text,
                });
            let _ = send.send(result);
        });
        Ok(receive)
    }
    pub fn speak(&self, request: SpeechSpeakRequest) -> Result<SpeechSnapshot, SpeechError> {
        validation::speak(&request)?;
        let operation = self.reserve(
            request.utterance_id,
            &request.epoch,
            SpeechState::Synthesizing,
        )?;
        let output = operation
            .scratch
            .as_ref()
            .ok_or(SpeechError::Unavailable)?
            .output();
        let payload = process::payload(json!({"text":request.text,"output":output}));
        let host = self.clone();
        std::thread::spawn(move || {
            let result = payload.and_then(|bytes| {
                host.execute(&operation, "speak", bytes, Duration::from_secs(120))
            });
            let _ = host.settle(&operation, result);
        });
        self.snapshot()
    }
    fn execute(
        &self,
        operation: &Operation,
        mode: &str,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> Result<String, SpeechError> {
        let deadline = Instant::now() + timeout;
        let frames = {
            let view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if !current(&view, operation) || operation.cancelled.load(Ordering::SeqCst) {
                return Err(SpeechError::Cancelled);
            }
            process::launch(mode, &operation.child, payload)?
        };
        super::frames::collect(&operation.cancelled, mode, frames, deadline, || {
            self.speaking(operation)
        })
    }
    fn speaking(&self, operation: &Operation) -> Result<(), SpeechError> {
        let snapshot = {
            let mut view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if !current(&view, operation) || operation.cancelled.load(Ordering::SeqCst) {
                return Err(SpeechError::Cancelled);
            }
            view.snapshot.state = SpeechState::Speaking;
            advance(&mut view)
        };
        (self.inner.publish)(snapshot);
        Ok(())
    }
    fn settle(
        &self,
        operation: &Operation,
        mut result: Result<String, SpeechError>,
    ) -> Result<String, SpeechError> {
        let cleanup = process::stop(&operation.child).and_then(|_| match &operation.scratch {
            Some(scratch) => scratch.clean(),
            None => Ok(()),
        });
        if let Err(error) = &cleanup {
            result = Err(error.clone());
        }
        #[cfg(test)]
        if let Some(gate) = self.inner.settlement_gate.lock().unwrap().take() {
            gate();
        }
        let snapshot = {
            let mut view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if !current(&view, operation) {
                return Err(SpeechError::Cancelled);
            }
            if cleanup.is_ok() && operation.cancelled.load(Ordering::SeqCst) {
                result = Err(SpeechError::Cancelled);
            }
            if cleanup.is_ok() {
                view.active = None;
            }
            view.snapshot.state = if result.is_ok() || matches!(result, Err(SpeechError::Cancelled))
            {
                SpeechState::Idle
            } else {
                SpeechState::Unavailable
            };
            view.snapshot.error = result.as_ref().err().cloned();
            advance(&mut view)
        };
        (self.inner.publish)(snapshot);
        result
    }
    pub fn shutdown(&self) -> Result<SpeechSnapshot, SpeechError> {
        self.stop_inner(None)
    }
    pub fn stop_epoch(&self, epoch: &str) -> Result<SpeechSnapshot, SpeechError> {
        self.stop_inner(Some(validation::epoch(epoch)?))
    }
    fn stop_inner(&self, epoch: Option<u64>) -> Result<SpeechSnapshot, SpeechError> {
        let (active, snapshot) = {
            let mut view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if let Some(epoch) = epoch {
                if epoch < view.epoch {
                    return Ok(view.snapshot.clone());
                }
                if epoch > view.epoch {
                    return Err(SpeechError::MalformedRequest);
                }
                view.epoch = view.epoch.checked_add(1).ok_or(SpeechError::Unavailable)?;
                view.snapshot.epoch = view.epoch.to_string();
            } else {
                view.closed = true;
            }
            if let Some(operation) = &view.active {
                operation.cancelled.store(true, Ordering::SeqCst);
            } else if epoch.is_some() {
                view.snapshot.state = SpeechState::Idle;
                view.snapshot.error = None;
            }
            (view.active.clone(), advance(&mut view))
        };
        if let Some(operation) = active {
            match self.settle(&operation, Err(SpeechError::Cancelled)) {
                Ok(_) | Err(SpeechError::Cancelled) => {}
                Err(error) => return Err(error),
            }
        } else {
            (self.inner.publish)(snapshot);
        }
        self.snapshot()
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "epoch_tests.rs"]
mod epoch_tests;
