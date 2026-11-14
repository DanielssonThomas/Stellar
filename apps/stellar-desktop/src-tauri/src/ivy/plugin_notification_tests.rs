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
fn expired_terminal_head_retires_without_starving_fresh_notice_or_replaying_after_restart() {
    let data = captured();
    let original = &data["producer_inspection_rpc"]["result"];
    let first = original["host"]["receipt"]["admission_id"]
        .as_str()
        .unwrap();
    let owner = data["binding"]["owner_session_id"].as_str().unwrap();
    let signal = std::env::temp_dir().join(format!(
        "stellar-expiry-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    assert!(!signal.exists());
    let mut paused = original.clone();
    paused["local_eligible"] = json!(false);
    paused["delivery_allowed"] = json!(false);
    let mut expired = paused.clone();
    expired["local_expired"] = json!(true);
    let mut fresh = original.clone();
    fresh["host"]["event_id"] = json!("e".repeat(64));
    fresh["host"]["descriptor"]["event_id"] = fresh["host"]["event_id"].clone();
    fresh["host"]["receipt"]["admission_id"] = json!("fresh-admission");
    let sequence = fresh["host"]["receipt"]["sequence"].as_u64().unwrap() + 1;
    let generation = fresh["host"]["receipt"]["execution_generation"]
        .as_u64()
        .unwrap()
        + 1;
    fresh["host"]["receipt"]["sequence"] = json!(sequence);
    fresh["host"]["receipt"]["execution_generation"] = json!(generation);
    fresh["host"]["result"] = json!({"result":{"final_response":"Fresh notification"}});
    let script = format!(
        "if (Test-Path '{}') {{ if ($request.params.admission_id -eq 'fresh-admission') {{ {} }} else {{ {} }} }} else {{ {} }}",
        signal.to_string_lossy().replace('\'', "''"),
        mock_reply(&fresh),
        mock_reply(&expired),
        mock_reply(&paused)
    );
    let (mut session, directory) = fixture(&script);
    session.record.session_id = Some(owner.into());
    session.event(start(&data)).unwrap();
    let path = session.journal.updates_path();
    let mut updates = Updates::load(&path, owner).unwrap();
    assert_eq!(updates.pending.len(), 1); // Legacy/general ineligibility stays conservative.
    let mut next = updates.notices[first].clone();
    next.admission.id = "fresh-admission".into();
    next.admission.sequence = sequence;
    next.admission.generation = generation;
    next.descriptor = fresh["host"]["descriptor"].clone();
    updates.admit(next.admission.clone()).unwrap();
    updates.notices.insert(next.admission.id.clone(), next);
    updates.save(&path).unwrap();
    std::fs::write(&signal, b"expired").unwrap();
    session.poll_updates().unwrap();
    let updates = Updates::load(&path, owner).unwrap();
    assert!(updates.pending.is_empty());
    assert_eq!(updates.settled_sequence, sequence);
    assert_eq!(updates.completed.len(), 1);
    assert_eq!(updates.completed[0].text, "Fresh notification");
    assert!(updates.completed[0].speech_claim.is_none());
    assert!(!updates.notices.contains_key(first));
    assert_eq!(expired["host"], original["host"]);
    let durable = std::fs::read(&path).unwrap();
    drop(session);
    let (mut restarted, restart_directory) = fixture(&script);
    restarted.record.session_id = Some(owner.into());
    std::fs::write(restarted.journal.updates_path(), &durable).unwrap();
    restarted.event(start(&data)).unwrap();
    assert_eq!(
        std::fs::read(restarted.journal.updates_path()).unwrap(),
        durable
    );
    drop(restarted);
    std::fs::remove_file(signal).unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    std::fs::remove_dir_all(restart_directory).unwrap();
}

#[test]
fn temporary_ineligibility_recovers_and_expiry_cannot_settle_unknown_or_running_work() {
    let data = captured();
    let original = &data["producer_inspection_rpc"]["result"];
    let owner = data["binding"]["owner_session_id"].as_str().unwrap();
    let body = format!(
        "$script:reads += 1; $v = {}; $v | Add-Member -NotePropertyName local_expired -NotePropertyValue $false; if ($script:reads -le 2) {{ $v.local_eligible=$false; $v.delivery_allowed=$false }}; $v",
        mock_reply(original)
    );
    let (mut session, directory) = fixture(&body);
    session.record.session_id = Some(owner.into());
    session.event(start(&data)).unwrap();
    assert_eq!(
        Updates::load(&session.journal.updates_path(), owner)
            .unwrap()
            .pending
            .len(),
        1
    );
    session.poll_updates().unwrap();
    assert_eq!(
        Updates::load(&session.journal.updates_path(), owner)
            .unwrap()
            .completed
            .len(),
        1
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
    for status in ["unknown", "queued", "started"] {
        let mut response = original.clone();
        response["local_eligible"] = json!(false);
        response["delivery_allowed"] = json!(false);
        response["local_expired"] = json!(true);
        response["host"]["delivery_allowed"] = json!(false);
        if status == "unknown" {
            response["host"]["status"] = json!("unknown");
        } else {
            response["host"]["receipt"]["status"] = json!(status);
            response["host"]["receipt"]["outcome"] = Value::Null;
            response["host"]["result"] = Value::Null;
            if status == "queued" {
                response["host"]["receipt"]["execution_generation"] = Value::Null;
            }
        }
        let (mut session, directory) = fixture(&mock_reply(&response));
        session.record.session_id = Some(owner.into());
        let result = session.event(start(&data));
        if status == "unknown" {
            assert_eq!(result, Err(IvyErrorCode::Uncertain));
        } else {
            result.unwrap();
        }
        let updates = Updates::load(&session.journal.updates_path(), owner).unwrap();
        assert_eq!(updates.settled_sequence, 0);
        assert!(updates.completed.is_empty());
        if status != "unknown" {
            assert_eq!(updates.pending.len(), 1);
        }
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn expiry_type_or_eligibility_contradiction_cannot_publish_or_advance() {
    let data = captured();
    let owner = data["binding"]["owner_session_id"].as_str().unwrap();
    for value in [json!(1), Value::Null, json!("true"), json!(true)] {
        let mut response = data["producer_inspection_rpc"]["result"].clone();
        response["local_expired"] = value;
        let (mut session, directory) = fixture(&mock_reply(&response));
        session.record.session_id = Some(owner.into());
        assert_eq!(session.event(start(&data)), Err(IvyErrorCode::Protocol));
        let updates = Updates::load(&session.journal.updates_path(), owner).unwrap();
        assert_eq!(updates.settled_sequence, 0);
        assert!(updates.completed.is_empty());
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
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
