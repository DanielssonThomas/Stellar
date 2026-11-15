#![cfg(windows)]
use super::{contracts::*, recovery_tests::fixture, update_store::Updates};
use serde_json::{Value, json};

fn start(admission: &str, sequence: u64) -> Value {
    json!({"event":"gateway","data":{"params":{
        "session_id":"session","admission_id":admission,"authority_epoch":2,"execution_generation":7,
        "seq":sequence,"replay_epoch":"replay","type":"message.start","payload":{"autonomous":true}
    }}})
}

const RECEIPT: &str = "@{ref=@{session_id='session'};admission_id=$request.params.admission_id;authority_epoch=2;execution_generation=7;sequence=4;status='terminal';outcome='completed';result=@{final_response='Verified background answer'}}";

#[test]
fn retained_pending_completion_is_recovered_without_a_new_prompt() {
    let receipt = format!(
        "$script:checks += 1; if ($script:checks -lt 3) {{ @{{ref=@{{session_id='session'}};admission_id=$request.params.admission_id;authority_epoch=2;execution_generation=7;sequence=4;status='started'}} }} else {{ {RECEIPT} }}"
    );
    let (mut session, directory) = fixture(&receipt);
    session.event(start("background", 10)).unwrap();
    assert_eq!(
        Updates::load(&session.journal.updates_path(), "session")
            .unwrap()
            .pending
            .len(),
        1
    );
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
    session
        .resume_updates(&json!({"replay_epoch":"replay","last_sequence":10}))
        .unwrap();
    assert_eq!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .background_updates
            .as_ref()
            .unwrap()[0]
            .text,
        "Verified background answer"
    );
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn receipt_authority_and_generation_must_match_the_retained_claim() {
    for (from, to) in [
        ("authority_epoch=2", "authority_epoch=9"),
        ("execution_generation=7", "execution_generation=9"),
    ] {
        let (mut session, directory) = fixture(&RECEIPT.replace(from, to));
        assert_eq!(
            session.event(start("background", 10)),
            Err(IvyErrorCode::Protocol)
        );
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

#[test]
fn maximum_escaped_text_history_round_trips_without_exceeding_its_storage_budget() {
    let (session, directory) = fixture(RECEIPT);
    let mut updates = Updates {
        session: "session".into(),
        ..Updates::default()
    };
    updates.completed = (0..8)
        .map(|index| IvyBackgroundUpdate {
            id: format!("{index}"),
            text: "\"".repeat(super::update_store::MAX_TEXT),
            speech_claim: None,
        })
        .collect();
    let path = session.journal.updates_path();
    updates.save(&path).unwrap();
    assert_eq!(
        Updates::load(&path, "session").unwrap().completed,
        updates.completed
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn verified_background_completion_does_not_replace_active_user_turn_and_replay_is_durable() {
    let (mut session, directory) = fixture(RECEIPT);
    session.event(start("background", 10)).unwrap();
    let before = session.record.input_id.clone();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(snapshot.turn, IvyTurnState::Uncertain);
    assert_eq!(session.record.input_id, before);
    assert!(session.record.unsettled);
    let update = &snapshot.background_updates.as_ref().unwrap()[0];
    assert_eq!(update.text, "Verified background answer");
    assert_eq!(update.speech_claim, None);
    session.event(start("background", 10)).unwrap();
    assert_eq!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .background_updates
            .as_ref()
            .unwrap()
            .len(),
        1
    );
    let request = IvyClaimUpdateRequest {
        version: 1,
        update_id: "background".into(),
        request_id: "00000000-0000-0000-0000-000000000299".into(),
    };
    session.claim_update(request.clone()).unwrap();
    let path = session.journal.updates_path();
    drop(session);
    let stored = Updates::load(&path, "session").unwrap();
    assert_eq!(
        stored.completed[0].speech_claim.as_deref(),
        Some(request.request_id.as_str())
    );
    assert_eq!(stored.settled_sequence, 4);
    assert!(stored.pending.is_empty());
    assert!(
        Updates::load(&path, "another-session")
            .unwrap()
            .completed
            .is_empty()
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn uncorrelated_completions_and_wrong_receipts_cannot_publish_background_content() {
    let (mut session, directory) = fixture(
        "@{ref=@{session_id='foreign'};admission_id='background';authority_epoch=2;execution_generation=7;sequence=4;status='terminal';outcome='completed';result=@{final_response='Do not show'}}",
    );
    let mut event = start("background", 10);
    event["data"]["params"]["type"] = json!("message.complete");
    event["data"]["params"]["payload"] = json!({"outcome":"completed","text":"unverified"});
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
        session.event(start("background", 11)),
        Err(IvyErrorCode::Protocol)
    );
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

#[test]
fn failed_or_cancelled_admissions_are_not_announced_as_successful_updates() {
    for outcome in ["failed", "cancelled", "interrupted"] {
        let receipt = RECEIPT.replace("outcome='completed'", &format!("outcome='{outcome}'"));
        let (mut session, directory) = fixture(&receipt);
        session.event(start("background", 10)).unwrap();
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
        let stored = Updates::load(&session.journal.updates_path(), "session").unwrap();
        assert!(stored.pending.is_empty());
        assert_eq!(stored.settled_sequence, 4);
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn session_reset_fences_old_generation_and_preserves_one_time_speech_claim() {
    let (mut session, directory) = fixture(RECEIPT);
    session.event(start("background", 10)).unwrap();
    let first = "00000000-0000-0000-0000-000000000001";
    for request in [first, "00000000-0000-0000-0000-000000000002"] {
        let result = session
            .claim_update(IvyClaimUpdateRequest {
                version: 1,
                update_id: "background".into(),
                request_id: request.into(),
            })
            .unwrap();
        assert_eq!(
            result.background_updates.unwrap()[0]
                .speech_claim
                .as_deref(),
            Some(first)
        );
    }
    session.reset_updates(7).unwrap();
    session.event(start("background", 11)).unwrap();
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
