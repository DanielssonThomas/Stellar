use super::{contracts::IvyErrorCode, session_tests::fixture};
use serde_json::json;

#[test]
fn unversioned_start_projection_cannot_hide_an_unsupported_descriptor() {
    for admission in ["admission", "background"] {
        for payload in [
            json!({"autonomous": true, "display_kind": "lifecycle_update"}),
            json!({"autonomous": true, "consent_revision": 999}),
            json!({"autonomous": "true"}),
            json!({}),
        ] {
            let (mut session, directory) = fixture();
            let updates = session.journal.updates_path();
            assert!(!updates.exists());
            assert_eq!(
                session.event(json!({"event":"gateway","data":{"params":{
                    "type":"message.start","session_id":"session","admission_id":admission,
                    "authority_epoch":2,"execution_generation":3,"seq":1,
                    "replay_epoch":"epoch","payload":payload
                }}})),
                Err(IvyErrorCode::Protocol)
            );
            assert!(!updates.exists());
            assert!(session.record.unsettled);
            assert!(
                session
                    .shared
                    .view
                    .lock()
                    .unwrap()
                    .snapshot
                    .background_updates
                    .is_none()
            );
            drop(session);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}

#[cfg(windows)]
#[test]
fn conflicting_repeated_start_does_not_replace_retained_admission_or_publish() {
    let receipt = "$script:checks += 1; $authority=if ($script:checks -le 2) {2} else {3}; @{ref=@{session_id='session'};admission_id='background';authority_epoch=$authority;execution_generation=7;sequence=4;status='started'}";
    let (mut session, directory) = super::recovery_tests::fixture(receipt);
    let mut event = json!({"event":"gateway","data":{"params":{
        "type":"message.start","session_id":"session","admission_id":"background",
        "authority_epoch":2,"execution_generation":7,"seq":1,
        "replay_epoch":"replay","payload":{"autonomous":true}
    }}});
    session.event(event.clone()).unwrap();
    let updates = session.journal.updates_path();
    let before = std::fs::read(&updates).unwrap();
    event["data"]["params"]["seq"] = json!(2);
    event["data"]["params"]["authority_epoch"] = json!(3);
    assert_eq!(session.event(event), Err(IvyErrorCode::Protocol));
    assert_eq!(std::fs::read(updates).unwrap(), before);
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .background_updates
            .is_none()
    );
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(windows)]
#[test]
fn stale_generation_conflict_cannot_advance_the_cursor_before_receipt_poll() {
    use super::update_store::{Admission, Updates};
    let receipt = "@{ref=@{session_id='session'};admission_id='background';authority_epoch=2;execution_generation=7;sequence=4;status='started'}";
    let (mut session, directory) = super::recovery_tests::fixture(receipt);
    let path = session.journal.updates_path();
    Updates {
        session: "session".into(),
        floor_generation: 7,
        cursor: Some(("replay".into(), 1)),
        pending: vec![Admission {
            id: "background".into(),
            generation: 8,
            authority: 2,
            sequence: 4,
        }],
        ..Updates::default()
    }
    .save(&path)
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        session.event(json!({"event":"gateway","data":{"params":{
            "type":"message.start","session_id":"session","admission_id":"background",
            "authority_epoch":2,"execution_generation":7,"seq":2,
            "replay_epoch":"replay","payload":{"autonomous":true}
        }}})),
        Err(IvyErrorCode::Protocol)
    );
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert!(session.record.unsettled);
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .background_updates
            .is_none()
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
