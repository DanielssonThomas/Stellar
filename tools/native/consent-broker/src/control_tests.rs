use crate::*;

pub(crate) fn prepare() -> Request {
    Request::Prepare(PrepareRequest {
        session_id: "original".into(),
    })
}
pub(crate) fn complete() -> Request {
    Request::Complete(ChallengeRequest {
        challenge_id: "a".repeat(64),
    })
}
pub(crate) fn cancel() -> Request {
    Request::Cancel(ChallengeRequest {
        challenge_id: "a".repeat(64),
    })
}
pub(crate) fn payload(packet: &[u8]) -> Vec<u8> {
    let (used, data) = PacketReader::new().ingest(packet).unwrap();
    assert_eq!(used, packet.len());
    data.unwrap()
}

#[test]
fn prefix_fragmentation_and_coalescing_preserve_packet_boundaries() {
    let request = ControlRequest::new(1, prepare()).unwrap();
    let bytes = encode_control_request(&request).unwrap();
    let mut reader = PacketReader::new();
    let mut decoded = vec![];
    for byte in &bytes {
        let (used, packet) = reader.ingest(&[*byte]).unwrap();
        assert_eq!(used, 1);
        if let Some(p) = packet {
            decoded.push(p);
        }
    }
    assert_eq!(decoded.len(), 1);
    assert_eq!(decode_control_request(&decoded[0]).unwrap(), request);
    assert_eq!(reader.finish(), Ok(()));
    assert_eq!(reader.ingest(&bytes), Err(Error::Uncertain));
    let two = [bytes.clone(), bytes.clone()].concat();
    let mut reader = PacketReader::new();
    let (used, first) = reader.ingest(&two).unwrap();
    assert_eq!(used, bytes.len());
    assert_eq!(first.unwrap(), decoded[0]);
    let (used2, second) = reader.ingest(&two[used..]).unwrap();
    assert_eq!(used + used2, two.len());
    assert_eq!(second.unwrap(), decoded[0]);
}

#[test]
fn invalid_lengths_and_partial_eof_seal_without_resynchronizing() {
    for size in [0_u32, 16_385, u32::MAX] {
        let mut reader = PacketReader::new();
        assert_eq!(
            reader.ingest(&size.to_le_bytes()),
            Err(Error::InvalidRequest)
        );
        assert_eq!(reader.ingest(&[1, 0, 0, 0, b'{']), Err(Error::Uncertain));
    }
    for bytes in [vec![1, 0], vec![3, 0, 0, 0, b'{']] {
        let mut reader = PacketReader::new();
        reader.ingest(&bytes).unwrap();
        assert_eq!(reader.finish(), Err(Error::InvalidRequest));
        assert_eq!(reader.finish(), Err(Error::Uncertain));
    }
    let mut full = 16_384_u32.to_le_bytes().to_vec();
    full.extend(vec![b'x'; 16_384]);
    let (used, packet) = PacketReader::new().ingest(&full).unwrap();
    assert_eq!(used, 16_388);
    assert_eq!(packet.unwrap().len(), 16_384);
}

#[test]
fn request_envelope_is_closed_and_bounded() {
    let expected = ControlRequest::new(1, prepare()).unwrap();
    let bytes = encode_control_request(&expected).unwrap();
    assert_eq!(decode_control_request(&payload(&bytes)).unwrap(), expected);
    for text in [
        r#"{"version":3,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s"}},"actor":"native"}"#,
        r#"{"version":3,"version":3,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s"}}}"#,
        r#"{"version":3,"sequence":1,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s"}}}"#,
        r#"{"version":3,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s","session_id":"s"}}}"#,
        r#"{"version":3,"sequence":1,"request":{"method":"completeConsent","params":{"challengeId":"a","Verified":true}}}"#,
    ] {
        assert!(decode_control_request(text.as_bytes()).is_err(), "{text}");
    }
    for version in [0, 2, 4] {
        let mut bad = expected.clone();
        bad.version = version;
        assert!(encode_control_request(&bad).is_err());
    }
    for sequence in [0, 9_007_199_254_740_992, u64::MAX] {
        assert!(ControlRequest::new(sequence, prepare()).is_err());
    }
    assert!(ControlRequest::new(9_007_199_254_740_991, prepare()).is_ok());
    assert!(decode_control_request(&[0xff]).is_err());
    assert!(decode_control_request(&vec![b' '; 16_385]).is_err());
}

#[test]
fn method_specific_success_and_bounded_errors_roundtrip() {
    for (request, result) in [
        (
            prepare(),
            Response::Prepared(Box::new(crate::tests::scope(1, 1))),
        ),
        (
            complete(),
            Response::Ticket(Ticket {
                consent_ticket: "b".repeat(64),
            }),
        ),
        (cancel(), Response::Cancelled(Cancelled { cancelled: true })),
    ] {
        let expected = ControlRequest::new(7, request).unwrap();
        let bytes = encode_control_reply(&expected, Ok(&result)).unwrap();
        assert_eq!(
            decode_control_reply(&payload(&bytes), &expected)
                .unwrap()
                .outcome,
            Ok(result)
        );
        let bytes = encode_control_reply(&expected, Err(Error::Uncertain)).unwrap();
        assert_eq!(
            decode_control_reply(&payload(&bytes), &expected)
                .unwrap()
                .outcome,
            Err(Error::Uncertain)
        );
    }
}

#[test]
fn reply_presence_null_duplicates_mismatch_and_retry_refuse() {
    let expected = ControlRequest::new(1, cancel()).unwrap();
    for text in [
        r#"{"version":3,"sequence":1,"result":{"cancelled":true},"error":{"code":"Busy","retryAuthorized":false}}"#,
        r#"{"version":3,"sequence":1,"result":null,"error":{"code":"Busy","retryAuthorized":false}}"#,
        r#"{"version":3,"sequence":1,"error":null,"result":{"cancelled":true}}"#,
        r#"{"version":3,"sequence":1}"#,
        r#"{"version":3,"sequence":2,"result":{"cancelled":true}}"#,
        r#"{"version":3,"sequence":1.0,"result":{"cancelled":true}}"#,
        r#"{"version":3,"sequence":1,"result":{"cancelled":true,"cancelled":true}}"#,
        r#"{"version":3,"sequence":1,"error":{"code":"Busy","retryAuthorized":true}}"#,
        r#"{"version":3,"sequence":1,"error":{"code":"Busy","retryAuthorized":false,"retryAuthorized":false}}"#,
        r#"{"version":3,"sequence":1,"error":{"code":"Busy","retryAuthorized":false},"reason":"private"}"#,
        r#"{"version":3,"sequence":1,"result":{"consentTicket":"a"}}"#,
    ] {
        assert!(
            decode_control_reply(text.as_bytes(), &expected).is_err(),
            "{text}"
        );
    }
    let ticket = Response::Ticket(Ticket {
        consent_ticket: "a".repeat(64),
    });
    assert!(encode_control_reply(&expected, Ok(&ticket)).is_err());
}
