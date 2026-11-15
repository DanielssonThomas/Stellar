use std::io::Write;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

pub(super) struct Dispatch {
    sealed: AtomicBool,
    next: Mutex<u64>,
}

impl Dispatch {
    pub(super) fn new() -> Self {
        Self {
            sealed: AtomicBool::new(false),
            next: Mutex::new(1),
        }
    }
    pub(super) fn seal(&self) {
        self.sealed.store(true, Ordering::SeqCst);
    }
    pub(super) fn is_sealed(&self) -> bool {
        self.sealed.load(Ordering::SeqCst)
    }
}

/// One reserved frame, not authentication. No Clone/Debug: never log ticket traffic.
pub struct Outbound {
    pub(super) sequence: u64,
    pub(super) bytes: Vec<u8>,
    pub(super) lineage: Arc<Dispatch>,
}

pub struct WriteObservation {
    pub(super) sequence: u64,
    pub(super) full_write: bool,
    pub(super) lineage: Arc<Dispatch>,
}

impl Outbound {
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    /// Called outside the client-state borrow so pending completion cannot hold
    /// the correlation lock over I/O. Short/failed writes are never continued.
    pub fn write_once(self, writer: &mut impl Write) -> WriteObservation {
        let full_write = self.dispatch(writer);
        WriteObservation {
            sequence: self.sequence,
            full_write,
            lineage: self.lineage,
        }
    }

    fn dispatch(&self, writer: &mut impl Write) -> bool {
        if self.lineage.is_sealed() {
            return false;
        }
        let Ok(mut next) = self.lineage.next.lock() else {
            self.lineage.seal();
            return false;
        };
        if self.lineage.is_sealed() || *next != self.sequence {
            self.lineage.seal();
            return false;
        }
        let full_write = writer
            .write(&self.bytes)
            .is_ok_and(|n| n == self.bytes.len())
            && writer.flush().is_ok()
            && !self.lineage.is_sealed();
        if full_write {
            *next += 1;
        } else {
            self.lineage.seal();
        }
        full_write
    }
}
