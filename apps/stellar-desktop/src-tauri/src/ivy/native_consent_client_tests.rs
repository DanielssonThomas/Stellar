use super::fixtures::*;
use super::*;
use std::io::{self, Write};
use stellar_consent_broker::encode_control_reply;

#[test]
fn fragmented_frames_and_coalesced_suffixes_use_pinned_codec() {
    let (origin, mut client) = open();
    let frame = client.prepare(&origin, clock()).unwrap();
    let request = sent(&mut client, frame);
    let bytes = encode_control_reply(&request, Ok(&prepared(&origin))).unwrap();
    for byte in &bytes[..bytes.len() - 1] {
        assert!(
            client
                .receive(&[*byte], &origin, clock())
                .unwrap()
                .is_empty()
        );
    }
    assert!(matches!(
        client
            .receive(&bytes[bytes.len() - 1..], &origin, clock())
            .unwrap()[..],
        [Event::Prepared]
    ));
    let complete = complete(&mut client, &origin);
    let cancel = cancel(&mut client, &origin);
    let mut bytes = encode_control_reply(&complete, Err(BrokerError::VerificationDenied)).unwrap();
    bytes.extend(cancelled(&cancel));
    let events = client.receive(&bytes, &origin, clock()).unwrap();
    assert!(matches!(
        events[..],
        [
            Event::Denied(BrokerError::VerificationDenied),
            Event::CancelAcknowledged
        ]
    ));
    assert_eq!(client.attempted_sequences(), [1, 2, 3]);
    assert_eq!(client.view().unwrap().max_admissions(), 2);
    assert!(matches!(
        client.complete(&origin, clock()),
        Err(ClientError::Spent)
    ));
}

struct BrokenWrite {
    mode: u8,
    writes: usize,
    flushes: usize,
}
impl Write for BrokenWrite {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.writes += 1;
        match self.mode {
            0 => Ok(bytes.len() - 1),
            1 => Err(io::Error::other("private error text")),
            _ => Ok(bytes.len()),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flushes += 1;
        Err(io::Error::other("unknown flush"))
    }
}

#[test]
fn partial_failed_and_unknown_flush_writes_never_retry_or_release_ids() {
    for mode in 0..3 {
        let (origin, mut client) = open();
        let outbound = client.prepare(&origin, clock()).unwrap();
        assert_eq!(client.attempted_sequences(), [1]);
        let mut writer = BrokenWrite {
            mode,
            writes: 0,
            flushes: 0,
        };
        assert_eq!(
            client
                .wrote(outbound.write_once(&mut writer), &origin, clock())
                .map(|_| ()),
            Err(ClientError::Uncertain)
        );
        assert_eq!(writer.writes, 1);
        assert_eq!(writer.flushes, usize::from(mode == 2));
        assert!(client.is_sealed());
        assert_eq!(client.attempted_sequences(), [1]);
        assert!(matches!(
            client.prepare(&origin, clock()),
            Err(ClientError::Uncertain)
        ));
    }
}

#[test]
fn clean_and_partial_eof_both_seal_one_lifetime_even_after_drop() {
    for partial in [false, true] {
        let origin = origin();
        let mut slot = ClientSlot::new_unverified();
        let mut client = slot.open(origin.clone(), clock()).unwrap();
        let _reserved = client.prepare(&origin, clock()).unwrap();
        if partial {
            client.receive(&[12, 0], &origin, clock()).unwrap();
        }
        assert_eq!(
            client.eof(),
            Err(if partial {
                ClientError::Protocol
            } else {
                ClientError::Uncertain
            })
        );
        assert_eq!(client.attempted_sequences(), [1]);
        assert!(client.is_sealed());
        drop(client);
        assert!(matches!(
            slot.open(origin, clock()),
            Err(ClientError::Spent)
        ));
    }
}

#[test]
fn invalid_prefix_duplicate_and_wrong_method_responses_are_sticky() {
    let (origin, mut client) = open();
    let _reserved = client.prepare(&origin, clock()).unwrap();
    assert!(matches!(
        client.receive(&[0; 4], &origin, clock()),
        Err(ClientError::Protocol)
    ));
    assert!(client.is_sealed());
    let (origin, mut client) = ready();
    let request = complete(&mut client, &origin);
    let wrong = format!(
        r#"{{"version":3,"sequence":{},"result":{{"cancelled":true}}}}"#,
        request.sequence
    );
    let mut bytes = (wrong.len() as u32).to_le_bytes().to_vec();
    bytes.extend(wrong.as_bytes());
    assert!(matches!(
        client.receive(&bytes, &origin, clock()),
        Err(ClientError::Protocol)
    ));
    assert_eq!(client.attempted_sequences(), [1, 2]);
    let (origin, mut client) = ready();
    let request = complete(&mut client, &origin);
    let bytes = ticket(&request);
    assert!(matches!(
        client.receive(&bytes, &origin, clock()).unwrap()[..],
        [Event::Ticket(_)]
    ));
    assert!(matches!(
        client.receive(&bytes, &origin, clock()),
        Err(ClientError::Protocol)
    ));
    assert!(client.is_sealed());
}

#[test]
fn static_valid_but_wrong_scope_keeps_attempt_after_lane_removes_correlation() {
    for field in 0..6 {
        let (origin, mut client) = open();
        let frame = client.prepare(&origin, clock()).unwrap();
        let request = sent(&mut client, frame);
        let mut wrong = origin.clone();
        match field {
            0 => wrong.profile_id = "other".into(),
            1 => wrong.session_id = "other".into(),
            2 => wrong.physical_target = "other".into(),
            3 => wrong.route = "other".into(),
            4 => wrong.producer_id = "other".into(),
            _ => wrong.worker_incarnation = "e".repeat(32),
        }
        let bytes = encode_control_reply(&request, Ok(&prepared(&wrong))).unwrap();
        assert!(matches!(
            client.receive(&bytes, &origin, clock()),
            Err(ClientError::ScopeChanged)
        ));
        assert!(client.is_sealed());
        assert_eq!(client.attempted_sequences(), [1]);
    }
}

#[test]
fn deadlines_and_clock_or_selected_target_changes_fence_completion() {
    for now in [
        Clock {
            wall_ms: 500,
            monotonic_ms: 10,
        },
        Clock {
            wall_ms: 101,
            monotonic_ms: 410,
        },
    ] {
        let (origin, mut client) = ready();
        assert!(matches!(
            client.complete(&origin, now),
            Err(ClientError::Expired)
        ));
        assert!(client.is_sealed());
    }
    for now in [
        Clock {
            wall_ms: 99,
            monotonic_ms: 10,
        },
        Clock {
            wall_ms: 100,
            monotonic_ms: 9,
        },
    ] {
        let (origin, mut client) = ready();
        assert!(matches!(
            client.complete(&origin, now),
            Err(ClientError::Uncertain)
        ));
    }
    let (mut origin, mut client) = ready();
    origin.physical_target = "new".into();
    assert!(matches!(
        client.complete(&origin, clock()),
        Err(ClientError::ScopeChanged)
    ));
}

#[test]
fn cancel_can_reserve_during_pending_completion_and_withholds_late_ticket_in_either_order() {
    for cancel_first in [false, true] {
        let (origin, mut client) = ready();
        let complete = complete(&mut client, &origin);
        let cancel = cancel(&mut client, &origin);
        assert_eq!(cancel.sequence, 3);
        if cancel_first {
            assert!(matches!(
                client
                    .receive(&cancelled(&cancel), &origin, clock())
                    .unwrap()[..],
                [Event::CancelAcknowledged]
            ));
        }
        assert!(matches!(
            client.receive(&ticket(&complete), &origin, clock()),
            Err(ClientError::Uncertain)
        ));
        assert!(client.is_sealed());
        assert_eq!(client.attempted_sequences(), [1, 2, 3]);
    }
}

#[test]
fn a_ticket_before_opt_out_does_not_make_later_cancel_ack_a_revocation_receipt() {
    let (origin, mut client) = ready();
    let complete = complete(&mut client, &origin);
    let events = client
        .receive(&ticket(&complete), &origin, clock())
        .unwrap();
    let Event::Ticket(ticket) = &events[0] else {
        panic!("expected passive data");
    };
    assert_eq!(ticket.consent_ticket, "d".repeat(64));
    let cancel = cancel(&mut client, &origin);
    assert!(matches!(
        client
            .receive(&cancelled(&cancel), &origin, clock())
            .unwrap()[..],
        [Event::CancelAcknowledged]
    ));
    assert!(matches!(
        client.prepare(&origin, clock()),
        Err(ClientError::Spent)
    ));
}

#[test]
fn another_unverified_clients_write_observation_cannot_settle_this_flow() {
    let (origin, mut first) = open();
    let (_, mut second) = open();
    let _first = first.prepare(&origin, clock()).unwrap();
    let foreign = second
        .prepare(&origin, clock())
        .unwrap()
        .write_once(&mut vec![]);
    assert_eq!(
        first.wrote(foreign, &origin, clock()).map(|_| ()),
        Err(ClientError::Protocol)
    );
    assert!(first.is_sealed());
    assert_eq!(first.attempted_sequences(), [1]);
}

#[test]
fn transport_loss_never_releases_a_pending_completion_or_exposes_a_ticket() {
    let (origin, mut client) = ready();
    let request = complete(&mut client, &origin);
    client.transport_lost();
    assert!(matches!(
        client.receive(&ticket(&request), &origin, clock()),
        Err(ClientError::Uncertain)
    ));
    assert_eq!(client.attempted_sequences(), [1, 2]);
}

#[test]
fn static_valid_excessive_lifetimes_refuse_and_exact_limits_remain_data_only() {
    for excessive in 0..3 {
        let (origin, mut client) = open();
        let outbound = client.prepare(&origin, clock()).unwrap();
        let request = sent(&mut client, outbound);
        let mut response = prepared(&origin);
        let Response::Prepared(value) = &mut response else {
            unreachable!();
        };
        value.challenge_expires_at = if excessive == 0 { 60_101 } else { 60_100 };
        value.expires_at = if excessive == 1 {
            604_800_101
        } else {
            604_800_100
        };
        let bytes = encode_control_reply(&request, Ok(&response)).unwrap();
        let result = client.receive(&bytes, &origin, clock());
        if excessive == 2 {
            assert!(matches!(result.unwrap()[..], [Event::Prepared]));
        } else {
            assert!(matches!(result, Err(ClientError::Protocol)));
            assert!(client.is_sealed());
        }
        assert_eq!(client.attempted_sequences(), [1]);
    }
}

#[test]
fn monotonic_overflow_and_delayed_reply_cannot_extend_request_eligibility() {
    let origin = origin();
    let now = Clock {
        wall_ms: 100,
        monotonic_ms: u64::MAX - 10,
    };
    let mut client = ClientSlot::new_unverified()
        .open(origin.clone(), now)
        .unwrap();
    assert!(matches!(
        client.prepare(&origin, now),
        Err(ClientError::Uncertain)
    ));
    assert!(client.is_sealed());
    let (_, mut client) = open();
    let outbound = client.prepare(&origin, clock()).unwrap();
    let request = sent(&mut client, outbound);
    let bytes = encode_control_reply(&request, Ok(&prepared(&origin))).unwrap();
    assert!(matches!(
        client.receive(
            &bytes,
            &origin,
            Clock {
                wall_ms: 100,
                monotonic_ms: 60_010
            }
        ),
        Err(ClientError::Expired)
    ));
    assert!(client.is_sealed());
}
