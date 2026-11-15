#![cfg(windows)]
use super::{contracts::*, recovery_tests::fixture, update_store::Updates};
use serde_json::{Value, json};

const RECEIPT: &str = "@{ref=@{session_id='session'};admission_id=$request.params.admission_id;authority_epoch=2;execution_generation=7;sequence=4;status='terminal';outcome='completed';result=@{final_response='Ordinary admitted answer 299'}}";

fn start() -> Value {
    if let Ok(path) = std::env::var("STELLAR_ORDINARY_EVENT_FIXTURE") {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    } else {
        json!({"event":"gateway","data":{"params":{
            "type":"message.start","session_id":"session","admission_id":"ordinary",
            "authority_epoch":2,"execution_generation":7,"seq":10,"replay_epoch":"replay",
            "payload":{"autonomous":true}
        }}})
    }
}

#[test]
fn ordinary_completion_survives_reconnect_without_replacing_foreground_or_reclaiming_speech() {
    let (mut session, directory) = fixture(RECEIPT);
    let foreground = session.record.clone();
    let event = start();
    session.event(event.clone()).unwrap();
    let visible = session.shared.view.lock().unwrap().snapshot.clone();
    let updates = visible.background_updates.as_ref().unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].text, "Ordinary admitted answer 299");
    assert_eq!(session.record.admission_id, foreground.admission_id);
    assert_eq!(session.record.input_id, foreground.input_id);
    assert_eq!(session.record.generation, foreground.generation);
    assert!(session.record.unsettled);
    session.event(event.clone()).unwrap();
    session
        .resume_updates(&json!({"replay_epoch":"replay","last_sequence":10}))
        .unwrap();
    let request = IvyClaimUpdateRequest {
        version: 1,
        update_id: "ordinary".into(),
        request_id: "00000000-0000-0000-0000-000000000299".into(),
    };
    let claimed = session.claim_update(request).unwrap();
    session.event(event).unwrap();
    let restored = Updates::load(&session.journal.updates_path(), "session").unwrap();
    assert_eq!(restored.completed.len(), 1);
    assert!(restored.completed[0].speech_claim.is_some());
    assert!(restored.pending.is_empty());
    assert_eq!(restored.settled_sequence, 4);
    assert!(
        Updates::load(&session.journal.updates_path(), "other-session")
            .unwrap()
            .completed
            .is_empty()
    );
    session.reset_updates(8).unwrap();
    session.event(start()).unwrap();
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
    if let Ok(path) = std::env::var("STELLAR_ORDINARY_SNAPSHOT_FIXTURE") {
        std::fs::write(
            path,
            serde_json::to_vec(&json!({
                "visible":visible,"claimed":claimed,"fixtureOnly":true
            }))
            .unwrap(),
        )
        .unwrap();
    }
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn ordinary_completion_requires_canonical_identity_and_terminal_success() {
    for (from, to) in [
        ("session_id='session'", "session_id='foreign'"),
        (
            "admission_id=$request.params.admission_id",
            "admission_id='foreign'",
        ),
        ("authority_epoch=2", "authority_epoch=99"),
        ("execution_generation=7", "execution_generation=99"),
        ("status='terminal'", "status='unknown'"),
    ] {
        let (mut session, directory) = fixture(&RECEIPT.replace(from, to));
        assert!(session.event(start()).is_err(), "{to}");
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
    for outcome in ["failed", "cancelled", "interrupted"] {
        let receipt = RECEIPT.replace("outcome='completed'", &format!("outcome='{outcome}'"));
        let (mut session, directory) = fixture(&receipt);
        session.event(start()).unwrap();
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
}

#[test]
fn ordinary_completion_is_text_only_and_never_leaks_across_session_switch() {
    let final_response = r#"{"stellar_presentation":{"action":"close_activity"},"text":"Ordinary admitted answer 299"}"#;
    let receipt = RECEIPT.replace("Ordinary admitted answer 299", final_response);
    let (mut session, directory) = fixture(&receipt);
    let mut foreign = start();
    foreign["data"]["params"]["session_id"] = json!("other-session");
    session.event(foreign).unwrap();
    assert!(!session.journal.updates_path().exists());
    session.event(start()).unwrap();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(
        snapshot.background_updates.unwrap()[0].text,
        "Ordinary admitted answer 299"
    );
    assert!(snapshot.items.is_empty());
    session.record.session_id = Some("other-session".into());
    session.event(start()).unwrap();
    assert!(
        Updates::load(&session.journal.updates_path(), "other-session")
            .unwrap()
            .completed
            .is_empty()
    );
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn ordinary_completion_regression_preserves_unknown_foreground_custody() {
    let (mut session, directory) = fixture(RECEIPT);
    session.record.admission_id = None;
    session.record.generation = None;
    session.journal.save(&session.record).unwrap();
    let path = session.journal.updates_path();
    Updates {
        session: "session".into(),
        cursor: Some(("replay".into(), 9)),
        ..Updates::default()
    }
    .save(&path)
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(session.event(start()), Err(IvyErrorCode::Uncertain));
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert!(session.record.unsettled);
    assert!(session.record.admission_id.is_none());
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

#[test]
fn ordinary_completion_regression_does_not_reclassify_previous_foreground_replay() {
    let (mut session, directory) =
        fixture(&RECEIPT.replace("execution_generation=7", "execution_generation=3"));
    let mut event = start();
    event["data"]["params"]["admission_id"] = json!("admission");
    event["data"]["params"]["execution_generation"] = json!(3);
    session.event(event.clone()).unwrap();
    let before = std::fs::read(session.journal.updates_path()).unwrap();
    session.record.admission_id = Some("next-foreground".into());
    session.event(event).unwrap();
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
    assert_eq!(
        std::fs::read(session.journal.updates_path()).unwrap(),
        before
    );
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
