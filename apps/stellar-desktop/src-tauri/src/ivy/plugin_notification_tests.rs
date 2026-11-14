#![cfg(windows)]
use super::{contracts::*, recovery_tests::fixture, update_store::Updates};
use serde_json::{Value, json};

fn captured() -> Value {
    if let Ok(path) = std::env::var("STELLAR_PLUGIN_FRAME_FIXTURE") {
        return serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    }
    serde_json::from_str(include_str!(
        "../../../../../tools/native/evidence/stellar-herdr-notification-forward-v1.json"
    ))
    .unwrap()
}
fn start(data: &Value) -> Value {
    if let Some(frames) = data["consumer_frames"].as_array() {
        return frames[0].clone();
    }
    let mut params = data["raw_start"]["params"].clone();
    params["payload"] = json!({"plugin_notification":params["payload"]["plugin_notification"]});
    json!({"event":"gateway","data":{"params":params}})
}
fn mock_reply(reply: &Value) -> String {
    format!(
        "'{}' | ConvertFrom-Json",
        serde_json::to_string(reply).unwrap().replace('\'', "''")
    )
}

#[test]
fn canonical_plugin_answer_is_text_only_durable_and_exact_binding_revoke_is_sticky() {
    let data = captured();
    let (mut session, directory) = fixture(&mock_reply(&data["producer_inspection_rpc"]["result"]));
    let owner = data["binding"]["owner_session_id"].as_str().unwrap();
    session.record.session_id = Some(owner.into());
    session.event(start(&data)).unwrap();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(snapshot.background_updates.as_ref().unwrap().len(), 1);
    assert_eq!(
        snapshot.background_updates.as_ref().unwrap()[0].text,
        "Fixture: the worker exited 0; the issue remains OPEN and requires review."
    );
    assert!(snapshot.items.is_empty());
    let visible = snapshot.clone();
    assert_eq!(session.record.admission_id.as_deref(), Some("admission"));
    assert!(session.record.unsettled);
    let id = data["raw_start"]["params"]["admission_id"]
        .as_str()
        .unwrap();
    for request in [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
    ] {
        let claimed = session
            .claim_update(IvyClaimUpdateRequest {
                version: 1,
                update_id: id.into(),
                request_id: request.into(),
            })
            .unwrap();
        assert_eq!(
            claimed.background_updates.as_ref().unwrap()[0]
                .speech_claim
                .as_deref(),
            Some("00000000-0000-0000-0000-000000000001")
        );
        if let Ok(file) = std::env::var("STELLAR_PLUGIN_SNAPSHOT_FIXTURE") {
            std::fs::write(
                file,
                serde_json::to_vec(&json!({
                    "fixtureOnly":true,"visible":visible,"claimed":claimed,
                    "source":"stellar-herdr-notification-forward-v1.json"
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }
    session.event(start(&data)).unwrap();
    let mut wrong_revision = data["raw_revoke"]["params"].clone();
    wrong_revision["payload"]["binding"]["revision"] = json!(2);
    session
        .event(json!({"event":"gateway","data":{"params":wrong_revision}}))
        .unwrap();
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .background_updates
            .is_some()
    );
    session
        .event(json!({"event":"gateway","data":{"params":data["raw_revoke"]["params"]}}))
        .unwrap();
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
    session.poll_updates().unwrap();
    let retained = Updates::load(&session.journal.updates_path(), owner).unwrap();
    assert!(retained.notices[id].revoked);
    assert_eq!(retained.completed.len(), 1);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn terminal_without_meaningful_answer_settles_without_publication_or_foreground_mutation() {
    let data = captured();
    for final_text in [json!(" "), Value::Null, json!("x".repeat(262145))] {
        let mut response = data["producer_inspection_rpc"]["result"].clone();
        response["delivery_allowed"] = json!(false);
        response["host"]["result"] = if final_text.is_null() {
            Value::Null
        } else {
            json!({"result":{"final_response":final_text}})
        };
        let body = if final_text.as_str().is_some_and(|v| v.len() > 262144) {
            format!(
                "$v = {}; $v.host.result.result.final_response='x'*262145; $v.delivery_allowed=$false; $v",
                mock_reply(&data["producer_inspection_rpc"]["result"])
            )
        } else {
            mock_reply(&response)
        };
        let (mut session, directory) = fixture(&body);
        let owner = data["binding"]["owner_session_id"].as_str().unwrap();
        session.record.session_id = Some(owner.into());
        session.event(start(&data)).unwrap();
        let updates = Updates::load(&session.journal.updates_path(), owner).unwrap();
        assert!(updates.pending.is_empty());
        assert!(updates.completed.is_empty());
        assert!(session.record.unsettled);
        assert_eq!(session.record.admission_id.as_deref(), Some("admission"));
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn retained_lifecycle_admission_cannot_change_protocol_to_plugin_notification() {
    let data = captured();
    let (mut session, directory) = fixture(&mock_reply(&data["producer_inspection_rpc"]["result"]));
    let owner = data["binding"]["owner_session_id"].as_str().unwrap();
    session.record.session_id = Some(owner.into());
    let mut g: Value = serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/lifecycle-v1.json"
    ))
    .unwrap();
    g["inspection"]["descriptor"]["origin"]["sessionId"] = json!(owner);
    g["inspection"]["receipt"]["ref"]["session_id"] = json!(owner);
    g["inspection"]["receipt"]["admission_id"] =
        data["raw_start"]["params"]["admission_id"].clone();
    let staging = super::lifecycle_store::Staging {
        session: owner.into(),
        cursor: Some(("epoch".into(), 1)),
        entries: vec![super::lifecycle_store::Entry {
            descriptor: serde_json::from_value(g["inspection"]["descriptor"].clone()).unwrap(),
            receipt: serde_json::from_value(g["inspection"]["receipt"].clone()).unwrap(),
            withheld: false,
        }],
    };
    staging.save(&session.lifecycle_path(owner)).unwrap();
    assert_eq!(session.event(start(&data)), Err(IvyErrorCode::Protocol));
    assert!(!session.journal.updates_path().exists());
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn local_eligibility_is_rechecked_before_claim_without_latching_false_as_revocation() {
    let data = captured();
    let body = format!(
        "$script:reads += 1; $v = {}; if ($script:reads -gt 3) {{ $v.local_eligible=$false; $v.delivery_allowed=$false }}; $v",
        mock_reply(&data["producer_inspection_rpc"]["result"])
    );
    let (mut session, directory) = fixture(&body);
    let owner = data["binding"]["owner_session_id"].as_str().unwrap();
    session.record.session_id = Some(owner.into());
    session.event(start(&data)).unwrap();
    let id = data["raw_start"]["params"]["admission_id"]
        .as_str()
        .unwrap();
    assert!(matches!(
        session.claim_update(IvyClaimUpdateRequest {
            version: 1,
            update_id: id.into(),
            request_id: "00000000-0000-0000-0000-000000000001".into()
        }),
        Err(IvyErrorCode::Unavailable)
    ));
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
    let retained = Updates::load(&session.journal.updates_path(), owner).unwrap();
    assert!(!retained.notices[id].revoked);
    assert!(retained.completed[0].speech_claim.is_none());
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn forged_canonical_marker_cannot_advance_replay_or_publish() {
    let data = captured();
    let mut response = data["producer_inspection_rpc"]["result"].clone();
    response["host"]["descriptor"]["payload_digest"] = json!("0".repeat(64));
    let (mut session, directory) = fixture(&mock_reply(&response));
    session.record.session_id = data["binding"]["owner_session_id"]
        .as_str()
        .map(str::to_owned);
    assert_eq!(session.event(start(&data)), Err(IvyErrorCode::Protocol));
    assert!(!session.journal.updates_path().exists());
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
