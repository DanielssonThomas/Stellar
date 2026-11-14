use crate::control_tests::{cancel, complete, payload, prepare};
use crate::*;

#[test]
fn reserved_cancel_runs_while_complete_is_inflight_and_replies_out_of_order() {
    let mut client = ClientLane::new();
    let mut server = ServerLane::new();
    for request in [complete(), prepare(), prepare()] {
        let (_, bytes) = client.reserve(request).unwrap();
        let frame = decode_control_request(&payload(&bytes)).unwrap();
        assert_eq!(server.accept(frame), Ok(Acceptance::Queued));
    }
    assert_eq!(client.reserve(prepare()), Err(Error::Busy));
    let running = server.take_next().unwrap().unwrap();
    assert_eq!(running.sequence, 1);
    assert!(matches!(running.request, Request::Complete(_)));
    let (cancel_seq, bytes) = client.reserve(cancel()).unwrap();
    assert_eq!(cancel_seq, 4);
    server
        .accept(decode_control_request(&payload(&bytes)).unwrap())
        .unwrap();
    assert_eq!(client.outstanding(), [1, 2, 3, 4]);
    let priority = server.take_next().unwrap().unwrap();
    assert_eq!(priority.sequence, 4);
    let cancelled = Response::Cancelled(Cancelled { cancelled: true });
    let ack = server.finish(4, Ok(&cancelled)).unwrap();
    assert!(client.receive(&payload(&ack)).unwrap().outcome.is_ok());
    let failed = server.finish(1, Err(Error::ChallengeCancelled)).unwrap();
    assert_eq!(
        client.receive(&payload(&failed)).unwrap().outcome,
        Err(Error::ChallengeCancelled)
    );
    assert_eq!(client.outstanding(), [2, 3]);
    assert_eq!(server.outstanding(), [2, 3]);
    assert_eq!(server.take_next().unwrap().unwrap().sequence, 2);
}

#[test]
fn one_complete_and_busy_rejection_consume_server_sequence_only_once() {
    let mut server = ServerLane::new();
    assert_eq!(
        server.accept(ControlRequest::new(1, complete()).unwrap()),
        Ok(Acceptance::Queued)
    );
    assert_eq!(
        server.accept(ControlRequest::new(2, complete()).unwrap()),
        Ok(Acceptance::RejectedBusy)
    );
    assert_eq!(
        server.accept(ControlRequest::new(3, cancel()).unwrap()),
        Ok(Acceptance::Queued)
    );
    assert_eq!(server.take_next().unwrap().unwrap().sequence, 3);
    assert_eq!(
        server.accept(ControlRequest::new(2, prepare()).unwrap()),
        Err(Error::InvalidRequest)
    );
    assert!(server.is_sealed());
    assert_eq!(server.outstanding(), [1, 3]);
    assert_eq!(server.take_next(), Err(Error::Uncertain));
}

#[test]
fn server_reserves_capacity_and_rejects_conflicting_replay_or_gap() {
    for bad in [1, 7] {
        let mut server = ServerLane::new();
        for sequence in 1..=3 {
            server
                .accept(ControlRequest::new(sequence, prepare()).unwrap())
                .unwrap();
        }
        assert_eq!(
            server.accept(ControlRequest::new(4, prepare()).unwrap()),
            Ok(Acceptance::RejectedBusy)
        );
        assert_eq!(
            server.accept(ControlRequest::new(5, cancel()).unwrap()),
            Ok(Acceptance::Queued)
        );
        assert_eq!(server.outstanding().len(), 4);
        let changed = ControlRequest::new(bad, complete()).unwrap();
        assert_eq!(server.accept(changed), Err(Error::InvalidRequest));
        assert!(server.is_sealed());
        assert_eq!(server.outstanding().len(), 4);
    }
}

#[test]
fn unknown_duplicate_wrong_method_and_nested_duplicate_replies_seal_client() {
    let bads = [
        r#"{"version":3,"sequence":2,"error":{"code":"Busy","retryAuthorized":false}}"#.to_string(),
        r#"{"version":3,"sequence":1,"result":{"cancelled":true}}"#.to_string(),
        format!(r#"{{"version":3,"sequence":1,"result":{{"consentTicket":"{}","consentTicket":"{}"}}}}"#, "a".repeat(64),"a".repeat(64)),
        r#"{"version":3,"sequence":1,"result":null,"error":{"code":"Busy","retryAuthorized":false}}"#.to_string(),
    ];
    for bad in bads {
        let mut client = ClientLane::new();
        client.reserve(complete()).unwrap();
        assert_eq!(client.receive(bad.as_bytes()), Err(Error::InvalidRequest));
        assert!(client.is_sealed());
        assert_eq!(client.outstanding(), [1]);
        assert_eq!(client.reserve(cancel()), Err(Error::Uncertain));
    }
    let mut client = ClientLane::new();
    client.reserve(cancel()).unwrap();
    let ack = br#"{"version":3,"sequence":1,"result":{"cancelled":true}}"#;
    client.receive(ack).unwrap();
    assert_eq!(client.receive(ack), Err(Error::InvalidRequest));
    assert!(client.is_sealed());
}

#[test]
fn lost_write_or_timeout_retains_reservations_without_a_retry_api() {
    let mut client = ClientLane::new();
    client.reserve(complete()).unwrap();
    client.close();
    assert_eq!(client.outstanding(), [1]);
    assert_eq!(client.reserve(complete()), Err(Error::Uncertain));
    let mut server = ServerLane::new();
    server
        .accept(ControlRequest::new(1, complete()).unwrap())
        .unwrap();
    server.take_next().unwrap();
    server.close();
    assert_eq!(server.outstanding(), [1]);
    assert_eq!(
        server.finish(1, Err(Error::Uncertain)),
        Err(Error::Uncertain)
    );
}

#[test]
fn server_payload_decoder_seals_on_malformed_then_valid_input() {
    for bad in [
        br#"{"version":3,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s","session_id":"s"}}}"#.as_slice(),
        br#"{"version":3,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s"}},"actor":"native"}"#,
        br#"{"version":3,"sequence":1,"request":null}"#,
        &[0xff],
    ] {
        let mut server=ServerLane::new();
        assert!(matches!(server.receive(bad),Err(Error::InvalidRequest)));
        assert!(server.is_sealed());
        let valid=encode_control_request(&ControlRequest::new(1,prepare()).unwrap()).unwrap();
        assert!(matches!(server.receive(&payload(&valid)),Err(Error::Uncertain)));
        assert!(server.outstanding().is_empty());
    }
    let mut server = ServerLane::new();
    let valid = encode_control_request(&ControlRequest::new(1, complete()).unwrap()).unwrap();
    assert_eq!(
        server.receive(&payload(&valid)).unwrap().disposition,
        Acceptance::Queued
    );
    assert!(server.receive(b"malformed").is_err());
    assert_eq!(server.outstanding(), [1]);
    assert_eq!(server.take_next(), Err(Error::Uncertain));
}

#[test]
fn server_cannot_finish_queued_unknown_or_wrong_method_work() {
    for sequence in [1, 99] {
        let mut server = ServerLane::new();
        server
            .accept(ControlRequest::new(1, cancel()).unwrap())
            .unwrap();
        assert_eq!(
            server.finish(sequence, Err(Error::Busy)),
            Err(Error::InvalidRequest)
        );
        assert!(server.is_sealed());
        assert_eq!(server.outstanding(), [1]);
    }
    let mut server = ServerLane::new();
    server
        .accept(ControlRequest::new(1, cancel()).unwrap())
        .unwrap();
    server.take_next().unwrap();
    let wrong = Response::Ticket(Ticket {
        consent_ticket: "a".repeat(64),
    });
    assert_eq!(server.finish(1, Ok(&wrong)), Err(Error::InvalidRequest));
    assert!(server.is_sealed());
    assert_eq!(server.outstanding(), [1]);
}
