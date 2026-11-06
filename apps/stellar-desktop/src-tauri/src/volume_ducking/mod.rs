#[cfg(test)]
mod ducking_tests;
mod mixer;
#[cfg(test)]
mod mixer_tests;
#[cfg(all(test, windows))]
mod native_probe;
mod ramp;

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use mixer::Mixer;
pub(super) use ramp::Endpoint;

pub(crate) struct Session {
    pub id: String,
    pub process: u32,
    pub endpoint: Box<dyn Endpoint>,
}

const TICK: Duration = Duration::from_millis(20);
const LEASE: Duration = Duration::from_secs(6);

enum Message {
    Active(bool),
    Shutdown,
}

#[derive(Default)]
pub struct VolumeDucking {
    worker: Mutex<Option<(mpsc::Sender<Message>, JoinHandle<()>)>>,
    closed: AtomicBool,
    speaker: Arc<AtomicU32>,
}

impl VolumeDucking {
    pub fn new(speaker: Arc<AtomicU32>) -> Self {
        Self {
            speaker,
            worker: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }

    pub fn set_active(&self, active: bool) -> Result<(), ()> {
        let mut worker = self.worker.lock().map_err(|_| ())?;
        if self.closed.load(Ordering::Acquire) {
            return Err(());
        }
        if worker.is_none() && active {
            let (send, receive) = mpsc::channel();
            let speaker = self.speaker.clone();
            let handle = std::thread::Builder::new()
                .name("ivy-volume".into())
                .spawn(move || run_with(receive, open, speaker))
                .map_err(|_| ())?;
            *worker = Some((send, handle));
        }
        if let Some((send, _)) = worker.as_ref() {
            send.send(Message::Active(active)).map_err(|_| ())?;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            self.closed.store(true, Ordering::Release);
            if let Some((send, handle)) = worker.take() {
                let _ = send.send(Message::Shutdown);
                let _ = handle.join();
            }
        }
    }
}

impl Drop for VolumeDucking {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn open() -> Result<Vec<Session>, ()> {
    #[cfg(windows)]
    return crate::reflex::duck_sessions();
    #[cfg(not(windows))]
    Err(())
}

fn run_with(
    receive: mpsc::Receiver<Message>,
    mut open: impl FnMut() -> Result<Vec<Session>, ()>,
    speaker: Arc<AtomicU32>,
) {
    let mut mixer = Mixer::default();
    let mut lease = None;
    let mut shutdown = None;
    let mut previous = Instant::now();
    let mut retry = previous;
    loop {
        let wait = if mixer.is_empty() && lease.is_none() {
            LEASE
        } else {
            TICK
        };
        match receive.recv_timeout(wait) {
            Ok(Message::Active(true)) if shutdown.is_none() => {
                lease = Some(Instant::now() + LEASE);
            }
            Ok(Message::Active(false)) => {
                lease = None;
            }
            Ok(Message::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                lease = None;
                shutdown.get_or_insert(Instant::now() + Duration::from_secs(1));
                std::thread::sleep(TICK);
            }
            _ => {}
        }
        let now = Instant::now();
        let active = lease.is_some_and(|deadline| now < deadline);
        if !active {
            lease = None;
        }
        let speaker = speaker.load(Ordering::Acquire);
        if active && now >= retry {
            if let Ok(sessions) = open() {
                if mixer.is_empty() {
                    previous = now;
                }
                mixer.discover(sessions, speaker);
            }
            retry = now + Duration::from_millis(250);
        }
        mixer.tick(active, now.duration_since(previous), speaker);
        previous = now;
        if shutdown.is_some_and(|deadline| mixer.is_empty() || now >= deadline) {
            break;
        }
    }
}
