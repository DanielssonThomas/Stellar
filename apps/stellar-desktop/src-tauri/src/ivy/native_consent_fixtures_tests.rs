use super::*;
use stellar_consent_broker::{
    Cancelled, ControlRequest, DisplayScope, decode_control_request, encode_control_reply,
};

pub(super) fn origin() -> Origin {
    Origin {
        profile_id: "ivy".into(),
        session_id: "original".into(),
        physical_target: "physical-1".into(),
        route: "acp".into(),
        producer_id: "worker".into(),
        worker_incarnation: "a".repeat(32),
    }
}
pub(super) fn clock() -> Clock {
    Clock {
        wall_ms: 100,
        monotonic_ms: 10,
    }
}
pub(super) fn open() -> (Origin, InactiveClient) {
    let origin = origin();
    let client = ClientSlot::new_unverified()
        .open(origin.clone(), clock())
        .unwrap();
    (origin, client)
}
pub(super) fn sent(client: &mut InactiveClient, outbound: Outbound) -> ControlRequest {
    let mut bytes = vec![];
    let origin = client.origin.clone();
    let now = client.last;
    assert!(
        client
            .wrote(outbound.write_once(&mut bytes), &origin, now)
            .unwrap()
            .is_empty()
    );
    decode_control_request(&bytes[4..]).unwrap()
}
pub(super) fn prepared(origin: &Origin) -> Response {
    Response::Prepared(Box::new(Prepared {
        version: 1,
        challenge_id: "b".repeat(64),
        connection_binding: "c".repeat(64),
        origin: origin.clone(),
        display_scope: DisplayScope {
            profile_label: "Ivy".into(),
            conversation_label: "Original".into(),
            producer_label: "Worker".into(),
            effects: vec!["render".into(), "speech".into()],
        },
        expires_at: 1000,
        max_admissions: 2,
        challenge_expires_at: 500,
    }))
}
pub(super) fn ready() -> (Origin, InactiveClient) {
    let (origin, mut client) = open();
    let outbound = client.prepare(&origin, clock()).unwrap();
    let request = sent(&mut client, outbound);
    let bytes = encode_control_reply(&request, Ok(&prepared(&origin))).unwrap();
    assert!(matches!(
        client.receive(&bytes, &origin, clock()).unwrap()[..],
        [Event::Prepared]
    ));
    (origin, client)
}
pub(super) fn complete(client: &mut InactiveClient, origin: &Origin) -> ControlRequest {
    let outbound = client.complete(origin, clock()).unwrap();
    sent(client, outbound)
}
pub(super) fn cancel(client: &mut InactiveClient, origin: &Origin) -> ControlRequest {
    let outbound = client.cancel(origin, clock()).unwrap();
    sent(client, outbound)
}
pub(super) fn ticket(request: &ControlRequest) -> Vec<u8> {
    encode_control_reply(
        request,
        Ok(&Response::Ticket(Ticket {
            consent_ticket: "d".repeat(64),
        })),
    )
    .unwrap()
}
pub(super) fn cancelled(request: &ControlRequest) -> Vec<u8> {
    encode_control_reply(
        request,
        Ok(&Response::Cancelled(Cancelled { cancelled: true })),
    )
    .unwrap()
}
