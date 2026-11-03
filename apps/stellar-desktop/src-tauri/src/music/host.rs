use super::contracts::{MusicLevels, MusicSnapshot, MusicStatus};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;

pub type Publisher = Arc<dyn Fn(MusicSnapshot) + Send + Sync>;
#[derive(Default)]
pub struct MusicFrame {
    pub levels: MusicLevels,
    pub tone: Option<u8>,
}
pub type Sink = Arc<dyn Fn(Option<MusicFrame>) + Send + Sync>;
pub type Capture = Arc<dyn Fn(Arc<AtomicBool>, Sink) -> Result<(), ()> + Send + Sync>;

struct State {
    generation: u64,
    sequence: u64,
    snapshot: MusicSnapshot,
}
struct Worker {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}
pub struct MusicHost {
    state: Arc<Mutex<State>>,
    worker: Mutex<Option<Worker>>,
    publish: Publisher,
    capture: Capture,
}

impl MusicHost {
    pub fn new(publish: Publisher) -> Self {
        Self::with_capture(publish, Arc::new(super::capture::run))
    }

    pub(super) fn with_capture(publish: Publisher, capture: Capture) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                generation: 0,
                sequence: 0,
                snapshot: MusicSnapshot {
                    version: 1,
                    sequence: "0".into(),
                    status: MusicStatus::Idle,
                    levels: MusicLevels::default(),
                    tone: None,
                },
            })),
            worker: Mutex::new(None),
            publish,
            capture,
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<MusicSnapshot, ()> {
        let mut worker = self.worker.lock().map_err(|_| ())?;
        if enabled && worker.as_ref().is_some_and(|w| !w.thread.is_finished()) {
            return Ok(self.state.lock().map_err(|_| ())?.snapshot.clone());
        }
        if let Some(old) = worker.take() {
            old.stop.store(true, Ordering::Release);
            let _ = old.thread.join();
        }
        let (generation, snapshot) = {
            let mut state = self.state.lock().map_err(|_| ())?;
            state.generation += 1;
            state.sequence += 1;
            state.snapshot = MusicSnapshot {
                version: 1,
                sequence: state.sequence.to_string(),
                status: if enabled {
                    MusicStatus::Starting
                } else {
                    MusicStatus::Idle
                },
                levels: MusicLevels::default(),
                tone: None,
            };
            (state.generation, state.snapshot.clone())
        };
        (self.publish)(snapshot.clone());
        if !enabled {
            return Ok(snapshot);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let state = self.state.clone();
        let publisher = self.publish.clone();
        let worker_stop = stop.clone();
        let sink: Sink = Arc::new(move |frame| {
            if worker_stop.load(Ordering::Acquire) {
                return;
            }
            let snapshot = {
                let Ok(mut state) = state.lock() else {
                    return;
                };
                if state.generation != generation {
                    return;
                }
                state.sequence += 1;
                state.snapshot.sequence = state.sequence.to_string();
                state.snapshot.status = MusicStatus::Capturing;
                let frame = frame.unwrap_or_default();
                state.snapshot.levels = frame.levels;
                state.snapshot.tone = frame.tone;
                state.snapshot.clone()
            };
            publisher(snapshot);
        });
        let state = self.state.clone();
        let publisher = self.publish.clone();
        let capture = self.capture.clone();
        let worker_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("stellar-music".into())
            .spawn(move || {
                let result = capture(worker_stop.clone(), sink);
                if result.is_err() && !worker_stop.load(Ordering::Acquire) {
                    let snapshot = {
                        let Ok(mut state) = state.lock() else {
                            return;
                        };
                        if state.generation != generation {
                            return;
                        }
                        state.sequence += 1;
                        state.snapshot = MusicSnapshot {
                            version: 1,
                            sequence: state.sequence.to_string(),
                            status: MusicStatus::Unavailable,
                            levels: MusicLevels::default(),
                            tone: None,
                        };
                        state.snapshot.clone()
                    };
                    publisher(snapshot);
                }
            })
            .map_err(|_| ())?;
        *worker = Some(Worker { stop, thread });
        Ok(snapshot)
    }

    pub fn shutdown(&self) {
        let _ = self.set_enabled(false);
    }
}

impl Drop for MusicHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}
