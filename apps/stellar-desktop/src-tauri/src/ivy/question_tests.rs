use super::session_tests::fixture;
use serde_json::json;
#[test]
fn questions_are_generation_fenced_and_replay_preserves_display_ack() {
    let (mut session, directory) = fixture();
    let event = |seq, admission: &str, kind: &str| {
        json!({"event":"gateway","data":{"params":{
            "type":kind,"session_id":"session","admission_id":admission,"execution_generation":3,
            "replay_epoch":"epoch","seq":seq,"payload":{"prompt_id":"q1","question":"Which monitor?","choices":["Left","Right"],"multi_select":false}
        }}})
    };
    session
        .event(event(1, "foreign", "clarify.request"))
        .unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .questions
            .is_none()
    );
    session
        .event(event(1, "admission", "clarify.request"))
        .unwrap();
    session
        .shared
        .update(1, |view| view.questions.as_mut().unwrap()[0].shown = true);
    session
        .event(event(2, "admission", "clarify.request"))
        .unwrap();
    let questions = session
        .shared
        .view
        .lock()
        .unwrap()
        .snapshot
        .questions
        .clone()
        .unwrap();
    assert_eq!(questions.len(), 1);
    assert!(questions[0].shown);
    session
        .event(event(3, "admission", "clarify.settled"))
        .unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .questions
            .as_ref()
            .unwrap()
            .is_empty()
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
