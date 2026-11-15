use super::{
    contracts::*,
    state::{self, State},
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub type Publisher = Arc<dyn Fn(AwarenessSnapshot) + Send + Sync>;
pub(super) type Shared = Arc<(Mutex<State>, Condvar)>;

pub struct AwarenessHost {
    shared: Shared,
    worker: Mutex<Option<JoinHandle<()>>>,
    preference: PathBuf,
    publish: Publisher,
}

impl AwarenessHost {
    pub fn new(directory: &Path, publish: Publisher) -> Self {
        let preference = directory.join("awareness-paused");
        let enabled = !preference.try_exists().unwrap_or(true);
        let shared = Arc::new((Mutex::new(State::new(enabled)), Condvar::new()));
        let worker_state = shared.clone();
        let publisher = publish.clone();
        let worker = std::thread::spawn(move || observe(worker_state, publisher));
        Self {
            shared,
            worker: Mutex::new(Some(worker)),
            preference,
            publish,
        }
    }

    pub fn snapshot(&self) -> Result<AwarenessSnapshot, AwarenessError> {
        self.shared
            .0
            .lock()
            .map(|state| state.snapshot.clone())
            .map_err(|_| AwarenessError::Unavailable)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<AwarenessSnapshot, AwarenessError> {
        let mut state = self
            .shared
            .0
            .lock()
            .map_err(|_| AwarenessError::Unavailable)?;
        if state.stopped {
            return Err(AwarenessError::Unavailable);
        }
        if enabled {
            match std::fs::remove_file(&self.preference) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(AwarenessError::Storage),
            }
        } else {
            let parent = self.preference.parent().ok_or(AwarenessError::Storage)?;
            std::fs::create_dir_all(parent)
                .and_then(|()| std::fs::write(&self.preference, b"paused\n"))
                .map_err(|_| AwarenessError::Storage)?;
        }
        state.enabled(enabled);
        let snapshot = state.snapshot.clone();
        drop(state);
        self.shared.1.notify_all();
        (self.publish)(snapshot.clone());
        Ok(snapshot)
    }

    pub fn workspace(&self, request: AwarenessWorkspace) -> Result<(), AwarenessError> {
        if !state::workspace_valid(&request) {
            return Err(AwarenessError::MalformedRequest);
        }
        let mut state = self
            .shared
            .0
            .lock()
            .map_err(|_| AwarenessError::Unavailable)?;
        if state.stopped || !state.snapshot.enabled {
            return Ok(());
        }
        state.snapshot.workspace = Some(request);
        state.workspace_at = state::now();
        Ok(())
    }

    pub fn provider(&self) -> crate::ivy::ContextProvider {
        provider(self.shared.clone())
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.shared.0.lock() {
            state.stopped = true;
            state.enabled(false);
        }
        self.shared.1.notify_all();
        if let Ok(mut worker) = self.worker.lock()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }
}

impl Drop for AwarenessHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn provider(shared: Shared) -> crate::ivy::ContextProvider {
    Arc::new(move |epoch| {
        let generation = {
            let state = shared.0.lock().ok()?;
            if state.stopped || !state.snapshot.enabled {
                return None;
            }
            state.generation
        };
        let shared = shared.clone();
        let epoch = epoch.to_string();
        Some(Arc::new(move || {
            let state = shared.0.lock().ok()?;
            if state.generation != generation {
                return None;
            }
            state.context(&epoch, state::now())
        }) as crate::ivy::ContextLease)
    })
}

fn observe(shared: Shared, publish: Publisher) {
    #[cfg(windows)]
    let mut media = None;
    let mut last_media = Instant::now() - Duration::from_secs(10);
    loop {
        let generation = {
            let Ok(mut state) = shared.0.lock() else {
                break;
            };
            while !state.stopped && !state.snapshot.enabled {
                #[cfg(windows)]
                {
                    media = None;
                }
                let Ok(resumed) = shared.1.wait(state) else {
                    return;
                };
                state = resumed;
                last_media = Instant::now() - Duration::from_secs(10);
            }
            if state.stopped {
                break;
            }
            state.generation
        };
        #[cfg(windows)]
        let (app, music) = {
            if media.is_none() && last_media.elapsed() >= Duration::from_secs(10) {
                media = super::windows::Media::new().ok();
            }
            let changed = media.as_ref().is_some_and(super::windows::Media::changed);
            let music = if changed || last_media.elapsed() >= Duration::from_secs(10) {
                last_media = Instant::now();
                Some(
                    media
                        .as_mut()
                        .map_or(Err(()), super::windows::Media::snapshot),
                )
            } else {
                None
            };
            if music.as_ref().is_some_and(Result::is_err) {
                media = None;
            }
            (super::windows::foreground(), music)
        };
        #[cfg(not(windows))]
        let (app, music) = {
            last_media = Instant::now();
            (Err(()), Some(Err(())))
        };
        let snapshot = {
            let Ok(mut state) = shared.0.lock() else {
                break;
            };
            state
                .observe(generation, app, music)
                .then(|| state.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            publish(snapshot);
        }
        let Ok(state) = shared.0.lock() else {
            break;
        };
        if state.stopped {
            break;
        }
        let _ = shared.1.wait_timeout(state, Duration::from_secs(1));
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
