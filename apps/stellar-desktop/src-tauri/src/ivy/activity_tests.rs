use super::{contracts::*, session_tests::fixture};
use serde_json::{Value, json};

fn event(sequence: u64, actions: Value) -> Value {
    json!({"event":"gateway","data":{"params":{
        "session_id":"session", "admission_id":"admission", "execution_generation":3,
        "replay_epoch":"epoch", "seq":sequence, "type":"stellar.activity", "payload":{"actions":actions}
    }}})
}

#[test]
fn activity_is_bounded_fenced_and_cleared_on_completion() {
    let (mut session, directory) = fixture();
    let row = json!({"id":"0123456789abcdef","kind":"memory","state":"running"});
    let mut foreign = event(1, json!([row]));
    foreign["data"]["params"]["admission_id"] = json!("old");
    session.event(foreign).unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .activity
            .is_empty()
    );
    session.event(event(2, json!([row]))).unwrap();
    let wire = serde_json::to_value(&session.shared.view.lock().unwrap().snapshot).unwrap();
    assert_eq!(wire["activity"], json!([row]));
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.activity[0].state,
        IvyActivityState::Running
    );
    let completed = json!({"id":"0123456789abcdef","kind":"memory","state":"completed"});
    session.event(event(1, json!([completed]))).unwrap();
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.activity[0].state,
        IvyActivityState::Running
    );
    session.event(event(3, json!([completed]))).unwrap();
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.activity[0].state,
        IvyActivityState::Completed
    );
    let mut done = event(4, json!([]));
    done["data"]["params"]["type"] = json!("message.complete");
    done["data"]["params"]["payload"] = json!({"outcome":"cancelled"});
    session.event(done).unwrap();
    session.event(event(5, json!([row]))).unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .activity
            .is_empty()
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_activity_never_enters_the_snapshot() {
    for rows in [
        json!([{"id":"secret path","kind":"shell","state":"running"}]),
        json!([{"id":"0123456789abcdef","kind":"shell","state":"running","args":"secret"}]),
        json!([{"id":"0123456789abcdef","kind":"invented","state":"running"}]),
        json!(vec![
            json!({"id":"0123456789abcdef","kind":"shell","state":"running"});
            13
        ]),
    ] {
        let (mut session, directory) = fixture();
        assert_eq!(session.event(event(1, rows)), Err(IvyErrorCode::Protocol));
        assert!(
            session
                .shared
                .view
                .lock()
                .unwrap()
                .snapshot
                .activity
                .is_empty()
        );
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
