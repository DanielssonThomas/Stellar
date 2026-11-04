#[cfg(test)]
mod ducking_tests;
mod ramp;

use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub(super) use ramp::Endpoint;
use ramp::Ramp;

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
}

impl VolumeDucking {
    pub fn set_active(&self, active: bool) -> Result<(), ()> {
        let mut worker = self.worker.lock().map_err(|_| ())?;
        if self.closed.load(Ordering::Acquire) {
            return Err(());
        }
        if worker.is_none() && active {
            let (send, receive) = mpsc::channel();
            let handle = std::thread::Builder::new()
                .name("ivy-volume".into())
                .spawn(move || run(receive))
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

fn open() -> Result<Box<dyn Endpoint>, ()> {
    #[cfg(windows)]
    return crate::reflex::duck_endpoint();
    #[cfg(not(windows))]
    Err(())
}

fn run(receive: mpsc::Receiver<Message>) {
    run_with(receive, open);
}

fn run_with(
    receive: mpsc::Receiver<Message>,
    mut open: impl FnMut() -> Result<Box<dyn Endpoint>, ()>,
) {
    let mut ramp: Option<Ramp> = None;
    let mut lease = None;
    let mut inhibited = false;
    let mut shutdown = None;
    let mut previous = Instant::now();
    let mut retry = previous;
    loop {
        let wait = if ramp.is_none() && lease.is_none() {
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
                inhibited = false;
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
        if active && !inhibited && ramp.is_none() && now >= retry {
            ramp = open().ok().and_then(|endpoint| Ramp::new(endpoint).ok());
            previous = now;
            retry = now + Duration::from_secs(1);
        }
        if let Some(current) = ramp.as_mut() {
            if !current.is_current() {
                // Restore the retained endpoint before inspecting the new default.
                current.restore();
                ramp = None;
            } else {
                match current.tick(active, now.duration_since(previous)) {
                    ramp::Progress::Restored => ramp = None,
                    ramp::Progress::Overridden => {
                        ramp = None;
                        inhibited = active;
                    }
                    ramp::Progress::Pending => {}
                }
            }
        }
        previous = now;
        if shutdown.is_some_and(|deadline| ramp.is_none() || now >= deadline) {
            break;
        }
    }
}
