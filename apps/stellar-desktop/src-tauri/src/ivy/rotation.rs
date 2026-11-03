use super::contracts::IvyErrorCode;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
        mpsc,
    },
    time::Duration,
};

const PENDING: u8 = 0;
const STARTED: u8 = 1;
const CANCELLED: u8 = 2;
const FINISHED: u8 = 3;
pub type Ticket = Arc<AtomicU8>;
pub type Pending = Arc<Mutex<Option<Ticket>>>;

pub fn ticket() -> Ticket {
    Arc::new(AtomicU8::new(PENDING))
}
pub fn start(ticket: &Ticket) -> bool {
    ticket
        .compare_exchange(PENDING, STARTED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}
pub fn finish(pending: &Pending, ticket: &Ticket) {
    ticket.store(FINISHED, Ordering::Release);
    clear(pending, ticket);
}
fn clear(pending: &Pending, ticket: &Ticket) {
    if let Ok(mut slot) = pending.lock()
        && slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, ticket))
    {
        *slot = None;
    }
}
pub fn cancel(pending: &Pending, ticket: &Ticket) -> bool {
    let cancelled = ticket
        .compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok();
    if cancelled {
        clear(pending, ticket);
    }
    cancelled
}
pub fn wait_for<T>(
    rx: mpsc::Receiver<Result<T, IvyErrorCode>>,
    pending: Pending,
    ticket: Ticket,
    timeout: Duration,
) -> Result<T, IvyErrorCode> {
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            if cancel(&pending, &ticket) || ticket.load(Ordering::Acquire) == CANCELLED {
                Err(IvyErrorCode::Unavailable)
            } else {
                Err(IvyErrorCode::Uncertain)
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if cancel(&pending, &ticket) {
                Err(IvyErrorCode::Timeout)
            } else if ticket.load(Ordering::Acquire) == CANCELLED {
                Err(IvyErrorCode::Unavailable)
            } else {
                Err(IvyErrorCode::Uncertain)
            }
        }
    }
}
