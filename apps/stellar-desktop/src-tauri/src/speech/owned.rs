use super::{
    contracts::SpeechError,
    host::SpeechHost,
    state::{Operation, current},
};
use std::sync::{Arc, atomic::Ordering};

/// Backend outcome after this exact operation's work and scratch cleanup. This
/// is not acoustic/audibility evidence or a remote custody acknowledgement.
#[derive(Clone, Debug, PartialEq)]
pub enum SpeechCompletion {
    Completed,
    Cancelled,
    Failed(SpeechError),
}

/// Native-only ownership, never reconstructed from an ID, epoch or snapshot.
/// Dropping a handle neither cancels playback nor certifies cleanup.
#[derive(Clone)]
pub struct OwnedSpeech {
    host: SpeechHost,
    operation: Arc<Operation>,
}

impl SpeechHost {
    /// One registry for this native host lifetime. Replacement must not forget
    /// queued/active ownership and acknowledge an old operation as absent.
    pub(crate) fn claim_resource_registry(&self) -> Result<(), SpeechError> {
        self.inner
            .resource_registry_claimed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| SpeechError::Busy)
    }
}

impl OwnedSpeech {
    pub(super) fn admitted(&self) -> super::contracts::SpeechSnapshot {
        self.operation.admitted.clone()
    }
    pub(super) fn new(host: SpeechHost, operation: Arc<Operation>) -> Self {
        Self { host, operation }
    }

    pub fn completion(&self) -> Result<Option<SpeechCompletion>, SpeechError> {
        self.operation
            .completion
            .lock()
            .map(|v| v.clone())
            .map_err(|_| SpeechError::Unavailable)
    }

    /// Cancels only this resource without advancing the global epoch or touching
    /// recognition/expression work. A replacement uses the shared warm child;
    /// stale handles may read their retained proof but must not touch that child.
    pub fn stop(&self) -> Result<SpeechCompletion, SpeechError> {
        {
            let view = self
                .host
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if !current(&view, &self.operation)
                || !view
                    .active
                    .as_ref()
                    .is_some_and(|v| Arc::ptr_eq(v, &self.operation))
            {
                return self.completion()?.ok_or(SpeechError::Unavailable);
            }
            self.operation.cancelled.store(true, Ordering::SeqCst);
        }
        // settle checks ownership while holding the view before shared-child
        // cleanup; it never waits for the warm transport mutex under that lock.
        let result = self
            .host
            .settle(&self.operation, Err(SpeechError::Cancelled));
        self.completion()?
            .ok_or_else(|| result.err().unwrap_or(SpeechError::Unavailable))
    }
}
