use super::fixtures::*;
use super::*;
use std::{
    io::{self, Write},
    sync::mpsc,
    thread,
    time::Duration,
};
use stellar_consent_broker::{decode_control_request, encode_control_reply};

#[test]
fn delayed_outbound_is_fenced_after_close_scope_loss_eof_or_owner_drop() {
    for cause in 0..4 {
        let (origin, mut client) = ready();
        let outbound = client.complete(&origin, clock()).unwrap();
        match cause {
            0 => client.transport_lost(),
            1 => {
                let mut changed = origin.clone();
                changed.route = "changed".into();
                assert!(matches!(
                    client.receive(&[], &changed, clock()),
                    Err(ClientError::ScopeChanged)
                ));
            }
            2 => {
                assert_eq!(client.eof(), Err(ClientError::Uncertain));
            }
            _ => drop(client),
        }
        let mut wire = vec![];
        let _observation = outbound.write_once(&mut wire);
        assert!(wire.is_empty());
    }
}

#[test]
fn reversing_reserved_dispatch_never_writes_or_retries_either_frame() {
    let (origin, mut client) = ready();
    let complete = client.complete(&origin, clock()).unwrap();
    let cancel = client.cancel(&origin, clock()).unwrap();
    let mut wire = vec![];
    let _cancel = cancel.write_once(&mut wire);
    assert!(client.is_sealed());
    let _complete = complete.write_once(&mut wire);
    assert!(wire.is_empty());
    assert_eq!(client.attempted_sequences(), [1, 2, 3]);
}

struct WaitingFlush {
    entered: mpsc::SyncSender<()>,
    release: mpsc::Receiver<()>,
    fail: bool,
}
impl Write for WaitingFlush {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.entered.send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(5)).unwrap();
        if self.fail {
            Err(io::Error::other("unknown write outcome"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn correlated_ticket_racing_flush_waits_for_success_and_failed_flush_never_releases_it() {
    for fail in [false, true] {
        let (origin, mut client) = ready();
        let outbound = client.complete(&origin, clock()).unwrap();
        let request = decode_control_request(&outbound.bytes[4..]).unwrap();
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, released) = mpsc::sync_channel(1);
        let writer = thread::spawn(move || {
            outbound.write_once(&mut WaitingFlush {
                entered,
                release: released,
                fail,
            })
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            client
                .receive(&ticket(&request), &origin, clock())
                .unwrap()
                .is_empty()
        );
        release.send(()).unwrap();
        let observation = writer.join().unwrap();
        let events = client.wrote(observation, &origin, clock());
        if fail {
            assert!(matches!(events, Err(ClientError::Uncertain)));
            assert!(client.is_sealed());
        } else {
            assert!(matches!(events.unwrap()[..], [Event::Ticket(_)]));
        }
        assert_eq!(client.attempted_sequences(), [1, 2]);
    }
}

#[test]
fn cancellation_reservation_and_closure_do_not_wait_for_blocked_writer() {
    let (origin, mut client) = ready();
    let outbound = client.complete(&origin, clock()).unwrap();
    let request = decode_control_request(&outbound.bytes[4..]).unwrap();
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, released) = mpsc::sync_channel(1);
    let writer = thread::spawn(move || {
        outbound.write_once(&mut WaitingFlush {
            entered,
            release: released,
            fail: false,
        })
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        client
            .receive(&ticket(&request), &origin, clock())
            .unwrap()
            .is_empty()
    );
    let cancel = client.cancel(&origin, clock()).unwrap();
    assert_eq!(cancel.sequence(), 3);
    client.transport_lost();
    release.send(()).unwrap();
    assert!(matches!(
        client.wrote(writer.join().unwrap(), &origin, clock()),
        Err(ClientError::Uncertain)
    ));
    let mut wire = vec![];
    let _cancel = cancel.write_once(&mut wire);
    assert!(wire.is_empty());
}

#[test]
fn deferred_prepared_is_revalidated_at_write_settlement_not_receipt_time() {
    for change_scope in [false, true] {
        let (origin, mut client) = open();
        let outbound = client.prepare(&origin, clock()).unwrap();
        let request = decode_control_request(&outbound.bytes[4..]).unwrap();
        let bytes = encode_control_reply(&request, Ok(&prepared(&origin))).unwrap();
        assert!(client.receive(&bytes, &origin, clock()).unwrap().is_empty());
        let observation = outbound.write_once(&mut vec![]);
        let mut current = origin.clone();
        let now = if change_scope {
            current.session_id = "changed".into();
            clock()
        } else {
            Clock {
                wall_ms: 500,
                monotonic_ms: 410,
            }
        };
        assert!(matches!(
            client.wrote(observation, &current, now),
            Err(ClientError::Expired | ClientError::ScopeChanged)
        ));
        assert!(client.is_sealed());
        assert_eq!(client.attempted_sequences(), [1]);
    }
}
