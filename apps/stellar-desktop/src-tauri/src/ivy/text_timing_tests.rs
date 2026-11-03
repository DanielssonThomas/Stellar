use super::{contracts::*, session_tests::fixture};
use serde_json::json;

#[test]
fn first_text_timing_is_admission_fenced_and_never_becomes_presentation_or_completion() {
    let (mut session, directory) = fixture();
    let event = |admission: &str, seq: u64| {
        json!({"event":"gateway","data":{"params":{
        "type":"stellar.first_text","session_id":"session","admission_id":admission,
        "execution_generation":3,"replay_epoch":"epoch","seq":seq,"payload":{"available":true}}}})
    };
    session.event(event("foreign", 1)).unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .first_text_observed
            .is_none()
    );
    session.event(event("admission", 2)).unwrap();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(snapshot.first_text_observed, Some(true));
    assert!(snapshot.items.is_empty());
    assert!(session.record.unsettled);
    session.event(event("admission", 1)).unwrap();
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.revision,
        snapshot.revision
    );
    let mut malformed = event("admission", 3);
    malformed["data"]["params"]["payload"] = json!({"available":true,"text":"forbidden"});
    assert!(matches!(
        session.event(malformed),
        Err(IvyErrorCode::Protocol)
    ));
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
