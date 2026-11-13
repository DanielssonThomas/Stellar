#![cfg(windows)]
use super::{contracts::*, replay_recovery_tests::*, update_store::Updates};
use serde_json::{Value, json};
use std::fs;

fn hidden(session: &super::session::Session) -> bool {
    session
        .shared
        .view
        .lock()
        .unwrap()
        .snapshot
        .background_updates
        .is_none()
}
fn tail_revoke(data: &Value, index: usize, seq: u64) -> Value {
    let mut p = data["raw_revoke"]["params"].clone();
    p["replay_epoch"] = data["recovery_rpc"]["snapshot"]["replay_epoch"].clone();
    p["seq"] = json!(seq);
    p["payload"]["binding"] =
        data["recovery_rpc"]["entries"][index]["descriptor"]["binding"].clone();
    p
}

#[test]
fn older_foreground_after_a_settled_background_is_not_an_autonomous_answer() {
    let mut data = capture(false);
    let (source, _) = seed(&data, false);
    let mut old = data["recovery_rpc"]["entries"][0].clone();
    old["receipt"]["admission_id"] = json!("older-foreground");
    old["receipt"]["sequence"] = json!(2);
    old["receipt"]["execution_generation"] = json!(2);
    old["input_id"] = json!("older-user-input");
    old["kind"] = json!("ordinary");
    old["descriptor"] = Value::Null;
    let mut current = old.clone();
    current["receipt"]["admission_id"] = json!("current-foreground");
    current["receipt"]["sequence"] = json!(3);
    current["receipt"]["execution_generation"] = json!(3);
    current["input_id"] = json!("00000000-0000-0000-0000-000000000099");
    data["recovery_rpc"]["entries"]
        .as_array_mut()
        .unwrap()
        .extend([old, current]);
    data["recovery_rpc"]["snapshot"]["execution_generation"] = json!(3);
    let (mut session, dir) = reopen(&source, &data, false);
    let before = fs::read(session.journal.updates_path()).unwrap();
    assert!(session.recover_updates().is_err());
    assert_eq!(before, fs::read(session.journal.updates_path()).unwrap());
    assert!(hidden(&session));
    cleanup(session, source, dir);
}

#[test]
fn lifecycle_staging_custody_cannot_be_reclassified_by_a_plugin_inventory() {
    use super::lifecycle_store::{Entry, Staging};
    let data = capture(false);
    let (source, owner) = seed(&data, false);
    let (mut session, dir) = reopen(&source, &data, false);
    let mut golden: Value = serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/lifecycle-v1.json"
    ))
    .unwrap();
    golden["inspection"]["descriptor"]["origin"]["sessionId"] = json!(owner);
    golden["inspection"]["receipt"]["ref"]["session_id"] = json!(owner);
    golden["inspection"]["receipt"]["admission_id"] =
        data["recovery_rpc"]["entries"][0]["receipt"]["admission_id"].clone();
    let state = Staging {
        session: owner.clone(),
        cursor: Some(("epoch".into(), 1)),
        entries: vec![Entry {
            descriptor: serde_json::from_value(golden["inspection"]["descriptor"].clone()).unwrap(),
            receipt: serde_json::from_value(golden["inspection"]["receipt"].clone()).unwrap(),
            withheld: false,
        }],
    };
    state.save(&session.lifecycle_path(&owner)).unwrap();
    let before = fs::read(session.journal.updates_path()).unwrap();
    assert!(session.recover_updates().is_err());
    assert_eq!(before, fs::read(session.journal.updates_path()).unwrap());
    assert!(hidden(&session));
    cleanup(session, source, dir);
}

#[test]
fn snapshot_to_live_tail_is_deduplicated_and_revocation_precedes_publication() {
    let mut data = capture(true);
    let (source, owner) = seed(&data, false);
    let revoke = tail_revoke(&data, 1, 1);
    data["recovery_rpc"]["tail"]["events"] = json!([revoke.clone(), revoke.clone()]);
    data["recovery_rpc"]["tail"]["last_sequence"] = json!(1);
    let (mut session, dir) = reopen(&source, &data, false);
    session
        .buffered
        .push(json!({"event":"gateway","data":{"params":revoke}}));
    session.recover_updates().unwrap();
    let state = Updates::load(&session.journal.updates_path(), &owner).unwrap();
    assert_eq!(state.cursor.unwrap().1, 1);
    assert!(!state.recovery_pending);
    assert!(hidden(&session));
    assert_eq!(state.completed.len(), 1);
    assert_eq!(
        state.completed[0].speech_claim.as_deref(),
        Some("00000000-0000-0000-0000-000000000088")
    );
    cleanup(session, source, dir);
}

#[test]
fn a_partial_tail_failure_survives_restart_as_a_durable_publication_barrier() {
    let mut data = capture(false);
    let (source, owner) = seed(&data, false);
    let good = tail_revoke(&data, 0, 1);
    let mut bad = good.clone();
    bad["seq"] = json!(2);
    bad["type"] = json!("message.start");
    bad["admission_id"] = json!("unaccounted-start");
    bad["payload"] = json!({"autonomous":"invalid"});
    data["recovery_rpc"]["tail"]["events"] = json!([good, bad]);
    data["recovery_rpc"]["tail"]["last_sequence"] = json!(2);
    let (mut session, dir) = reopen(&source, &data, false);
    let unknown = fs::read(dir.join("copied/ivy-session.json")).unwrap();
    assert!(session.recover_updates().is_err());
    assert!(hidden(&session));
    assert!(
        Updates::load(&session.journal.updates_path(), &owner)
            .unwrap()
            .recovery_pending
    );
    drop(session);
    let (mut restarted, second) = reopen(&dir.join("copied"), &data, false);
    restarted.poll_updates().unwrap();
    assert!(hidden(&restarted));
    assert_eq!(
        restarted
            .claim_update(IvyClaimUpdateRequest {
                version: 1,
                update_id: data["raw_start"]["params"]["admission_id"]
                    .as_str()
                    .unwrap()
                    .into(),
                request_id: "00000000-0000-0000-0000-000000000089".into()
            })
            .unwrap_err(),
        IvyErrorCode::Unavailable
    );
    assert!(
        restarted
            .resume_updates(&data["resume_after_restart"]["result"])
            .is_err()
    );
    assert!(hidden(&restarted));
    assert_eq!(
        unknown,
        fs::read(second.join("copied/ivy-session.json")).unwrap()
    );
    cleanup(restarted, dir, second);
    fs::remove_dir_all(source).unwrap();
}

#[test]
fn buffered_old_epoch_events_need_an_exact_inventory_explanation() {
    for conflict in [false, true] {
        let data = capture(true);
        let (source, owner) = seed(&data, false);
        let (mut session, dir) = reopen(&source, &data, false);
        let mut p = data["raw_start"]["params"].clone();
        let entry = &data["recovery_rpc"]["entries"][1];
        p["seq"] = json!(99);
        p["admission_id"] = entry["receipt"]["admission_id"].clone();
        p["authority_epoch"] = entry["receipt"]["authority_epoch"].clone();
        p["execution_generation"] = entry["receipt"]["execution_generation"].clone();
        p["payload"] = json!({"plugin_notification":entry["descriptor"]});
        if conflict {
            p["execution_generation"] = json!(999);
        }
        session
            .buffered
            .push(json!({"event":"gateway","data":{"params":p}}));
        let before = fs::read(session.journal.updates_path()).unwrap();
        if conflict {
            assert!(session.recover_updates().is_err());
            assert_eq!(before, fs::read(session.journal.updates_path()).unwrap());
            assert!(hidden(&session));
        } else {
            session.recover_updates().unwrap();
            assert_eq!(
                Updates::load(&session.journal.updates_path(), &owner)
                    .unwrap()
                    .completed
                    .len(),
                2
            );
        }
        cleanup(session, source, dir);
    }
}

#[test]
fn restart_immediately_after_staging_requires_recovery_before_release() {
    let data = capture(false);
    let (source, owner) = seed(&data, false);
    let path = source.join("ivy-updates.json");
    let mut state = Updates::load(&path, &owner).unwrap();
    state.recovery_pending = true;
    state.cursor = Some((
        data["recovery_rpc"]["snapshot"]["replay_epoch"]
            .as_str()
            .unwrap()
            .into(),
        0,
    ));
    state.save(&path).unwrap();
    let (mut session, dir) = reopen(&source, &data, false);
    session.poll_updates().unwrap();
    assert!(hidden(&session));
    assert!(
        Updates::load(&session.journal.updates_path(), &owner)
            .unwrap()
            .recovery_pending
    );
    session
        .resume_updates(&data["resume_after_restart"]["result"])
        .unwrap();
    assert!(
        !Updates::load(&session.journal.updates_path(), &owner)
            .unwrap()
            .recovery_pending
    );
    assert!(hidden(&session));
    assert!(
        fs::read_to_string(dir.join("calls.txt"))
            .unwrap()
            .contains("stellar.session.recover")
    );
    cleanup(session, source, dir);
}

#[test]
fn conflicting_duplicate_tail_frames_cannot_stage_a_new_cursor() {
    let mut data = capture(false);
    let (source, _) = seed(&data, false);
    let first = tail_revoke(&data, 0, 1);
    let mut conflicting = first.clone();
    conflicting["payload"]["in_flight"] = json!(["different"]);
    data["recovery_rpc"]["tail"]["events"] = json!([first, conflicting]);
    data["recovery_rpc"]["tail"]["last_sequence"] = json!(1);
    let (mut session, dir) = reopen(&source, &data, false);
    let before = fs::read(session.journal.updates_path()).unwrap();
    assert!(session.recover_updates().is_err());
    assert_eq!(before, fs::read(session.journal.updates_path()).unwrap());
    assert!(hidden(&session));
    cleanup(session, source, dir);
}
