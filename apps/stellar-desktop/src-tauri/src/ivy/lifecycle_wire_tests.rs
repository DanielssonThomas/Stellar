use super::{
    contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_receipt::*, lifecycle_store::Staging,
};
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/lifecycle-v1.json"
    ))
    .unwrap()
}
fn values() -> (Binding, Inspection, u64) {
    let g = golden();
    (
        serde_json::from_value(g["binding"].clone()).unwrap(),
        serde_json::from_value(g["inspection"].clone()).unwrap(),
        g["now"].as_u64().unwrap(),
    )
}

#[test]
fn producer_descriptor_and_canonical_receipt_validate_without_effect_authority() {
    let (binding, inspection, now) = values();
    let descriptor = inspection.descriptor.as_ref().unwrap();
    assert_eq!(golden()["contractSha256"], CONTRACT_SHA256);
    assert!(descriptor.bound_to(&binding));
    inspection.validate(descriptor).unwrap();
    let mut stage = Staging {
        session: "session".into(),
        ..Staging::default()
    };
    stage
        .observe(&binding, inspection.clone(), "replay", 10, now)
        .unwrap();
    stage
        .observe(&binding, inspection, "replay", 10, now)
        .unwrap();
    assert_eq!(stage.entries.len(), 1);
    assert!(!stage.entries[0].withheld);
    // Staging has no renderer or speech dispatch port.
    assert_eq!(stage.cursor, Some(("replay".into(), 10)));
}

#[test]
fn closed_wire_rejects_extra_fields_wrong_types_and_unsafe_values() {
    let original = golden()["inspection"].clone();
    for (pointer, value) in [
        ("/schemaVersion", json!(true)),
        ("/retryAuthorized", json!(true)),
        ("/deliveryAuthorized", json!(true)),
        ("/descriptor/consentRevision", json!(SAFE + 1)),
        ("/descriptor/eventId", json!("é".repeat(129))),
        ("/descriptor/digest", json!("F".repeat(64))),
        ("/receipt/result/final_response", json!(" ")),
        ("/receipt/result/final_response", json!("é".repeat(131073))),
        ("/receipt/execution_generation", json!(7.0)),
        ("/receipt/ref/profile_id", json!("foreign")),
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        if pointer == "/deliveryAuthorized" {
            changed["status"] = json!("admitted");
        }
        let result: Result<Inspection, _> = serde_json::from_value(changed);
        assert!(
            result.is_err()
                || result
                    .unwrap()
                    .validate(&serde_json::from_value(original["descriptor"].clone()).unwrap())
                    .is_err(),
            "{pointer}"
        );
    }
    for pointer in [
        "",
        "/descriptor",
        "/descriptor/origin",
        "/receipt",
        "/receipt/ref",
        "/receipt/result",
    ] {
        let mut changed = original.clone();
        changed
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("authorityFromText".into(), json!(true));
        assert!(serde_json::from_value::<Inspection>(changed).is_err());
    }
}

#[test]
fn unknown_never_retries_and_queued_nullable_owner_matches_producer_shape() {
    let (_, original, _) = values();
    let descriptor = original.descriptor.clone().unwrap();
    let unknown: Inspection = serde_json::from_value(
        json!({"schemaVersion":1,"status":"unknown","retryAuthorized":false}),
    )
    .unwrap();
    assert_eq!(unknown.validate(&descriptor), Err(IvyErrorCode::Uncertain));
    let mut queued = original;
    queued.status = "admitted".into();
    queued.delivery_authorized = Some(false);
    let r = queued.receipt.as_mut().unwrap();
    r.status = "queued".into();
    r.outcome = None;
    r.result = None;
    r.authority_epoch = None;
    r.execution_generation = None;
    queued.validate(&descriptor).unwrap();
}

#[test]
fn replay_conflict_changed_binding_and_epoch_fail_before_mutation() {
    let (binding, inspection, now) = values();
    let mut stage = Staging {
        session: "session".into(),
        ..Staging::default()
    };
    stage
        .observe(&binding, inspection.clone(), "replay", 1, now)
        .unwrap();
    let before = serde_json::to_value(&stage).unwrap();
    for mode in ["digest", "physical", "result", "sequence", "epoch"] {
        let mut changed = inspection.clone();
        let mut b = binding.clone();
        match mode {
            "digest" => changed.descriptor.as_mut().unwrap().digest = "b".repeat(64),
            "physical" => {
                b.origin.physical_target = "other".into();
                changed.descriptor.as_mut().unwrap().origin = b.origin.clone();
            }
            "result" => {
                changed
                    .receipt
                    .as_mut()
                    .unwrap()
                    .result
                    .as_mut()
                    .unwrap()
                    .final_response = "altered".into()
            }
            "sequence" => changed.receipt.as_mut().unwrap().sequence += 1,
            _ => {}
        }
        assert!(
            stage
                .observe(
                    &b,
                    changed,
                    if mode == "epoch" { "other" } else { "replay" },
                    2,
                    now
                )
                .is_err()
        );
        assert_eq!(serde_json::to_value(&stage).unwrap(), before);
    }
}

#[test]
fn revocation_expiry_and_restart_never_restore_a_withheld_staged_answer() {
    let (binding, inspection, now) = values();
    let directory =
        std::env::temp_dir().join(format!("stellar-lifecycle-stage-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("state.json");
    let mut state = Staging {
        session: "session".into(),
        ..Staging::default()
    };
    state
        .observe(&binding, inspection.clone(), "replay", 1, now)
        .unwrap();
    state.save(&path).unwrap();
    let mut state = Staging::load(&path, "session").unwrap();
    let mut revoked = binding.clone();
    revoked.revoked = true;
    let mut denied = inspection.clone();
    denied.delivery_authorized = Some(false);
    state.observe(&revoked, denied, "replay", 2, now).unwrap();
    state.save(&path).unwrap();
    let mut state = Staging::load(&path, "session").unwrap();
    state
        .observe(&binding, inspection.clone(), "replay", 3, now)
        .unwrap();
    assert!(state.entries[0].withheld);
    assert!(state.entries[0].receipt.result.is_none());
    assert!(Staging::load(&path, "foreign").is_err());
    state
        .observe(&binding, inspection, "replay", 4, binding.expires_at)
        .unwrap();
    assert!(state.entries[0].withheld);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn lost_ack_and_revocation_result_shapes_cannot_authorize_reexecution_or_stopped_effects() {
    for (status, execute, ok) in [
        ("claimed", true, true),
        ("unknown", false, true),
        ("finished", false, true),
        ("unknown", true, false),
        ("finished", true, false),
    ] {
        let result: EffectBegin =
            serde_json::from_value(json!({"status":status,"execute":execute})).unwrap();
        assert_eq!(result.validate().is_ok(), ok);
    }
    for (status, committed, stopped, ok) in [
        ("active", false, false, true),
        ("revoking", true, false, true),
        ("revoked", true, true, true),
        ("revoking", true, true, false),
        ("revoked", false, true, false),
    ] {
        let result: Revocation = serde_json::from_value(
            json!({"status":status,"revocationCommitted":committed,"effectsStopped":stopped}),
        )
        .unwrap();
        assert_eq!(result.validate().is_ok(), ok);
    }
}

#[test]
fn capacity_preserves_staged_proof_and_unknown_never_advances_cursor() {
    let (binding, inspection, now) = values();
    let mut state = Staging {
        session: "session".into(),
        ..Staging::default()
    };
    for n in 1..=16 {
        let mut next = inspection.clone();
        next.descriptor.as_mut().unwrap().event_id = n.to_string();
        next.receipt.as_mut().unwrap().admission_id = n.to_string();
        next.receipt.as_mut().unwrap().sequence = n;
        state.observe(&binding, next, "replay", n, now).unwrap();
    }
    let before = serde_json::to_value(&state).unwrap();
    let mut overflow = inspection;
    overflow.receipt.as_mut().unwrap().sequence = 17;
    assert_eq!(
        state.observe(&binding, overflow, "replay", 17, now),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(serde_json::to_value(&state).unwrap(), before);
    let unknown: Inspection = serde_json::from_value(
        json!({"schemaVersion":1,"status":"unknown","retryAuthorized":false}),
    )
    .unwrap();
    assert_eq!(
        state.observe(&binding, unknown, "replay", 18, now),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(serde_json::to_value(&state).unwrap(), before);
}

#[test]
fn actual_unknown_variants_remain_uncertain_and_nullable_keys_are_required() {
    let (_, inspection, _) = values();
    let descriptor = inspection.descriptor.as_ref().unwrap();
    let mut unknown = golden()["inspection"].clone();
    unknown["status"] = json!("unknown");
    unknown["deliveryAuthorized"] = json!(false);
    unknown.as_object_mut().unwrap().remove("receipt");
    let decoded: Inspection = serde_json::from_value(unknown.clone()).unwrap();
    assert_eq!(decoded.validate(descriptor), Err(IvyErrorCode::Uncertain));
    unknown["receipt"] = golden()["inspection"]["receipt"].clone();
    unknown["receipt"]["status"] = json!("unknown");
    unknown["receipt"]["outcome"] = Value::Null;
    unknown["receipt"]["authority_epoch"] = Value::Null;
    unknown["receipt"]["execution_generation"] = Value::Null;
    unknown["receipt"].as_object_mut().unwrap().remove("result");
    let decoded: Inspection = serde_json::from_value(unknown).unwrap();
    assert_eq!(decoded.validate(descriptor), Err(IvyErrorCode::Uncertain));
    for field in ["outcome", "authority_epoch", "execution_generation"] {
        let mut changed = golden()["inspection"].clone();
        changed["receipt"].as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<Inspection>(changed).is_err(),
            "{field}"
        );
    }
    for field in ["descriptor", "deliveryAuthorized", "receipt"] {
        let mut changed = golden()["inspection"].clone();
        changed[field] = Value::Null;
        assert!(
            serde_json::from_value::<Inspection>(changed).is_err(),
            "{field}"
        );
    }
}

#[test]
fn native_identifiers_match_producer_printability_including_format_and_unassigned_characters() {
    for bad in ["a\u{200d}b", "\u{e000}", "\u{0378}", "a b", "a\n"] {
        assert!(!id(bad, 256), "{bad:?}");
    }
    for good in ["event-é", "event-😀", "a/b:c"] {
        assert!(id(good, 256), "{good:?}");
    }
}

#[test]
fn corrupt_withheld_and_missing_authorized_result_are_not_loaded_or_repaired() {
    let (binding, inspection, now) = values();
    let mut stage = Staging {
        session: "session".into(),
        ..Staging::default()
    };
    stage
        .observe(&binding, inspection, "replay", 1, now)
        .unwrap();
    let directory =
        std::env::temp_dir().join(format!("stellar-lifecycle-corrupt-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("state.json");
    for mode in ["withheld", "missing_result"] {
        let mut value = serde_json::to_value(&stage).unwrap();
        if mode == "withheld" {
            value["entries"][0]["withheld"] = json!(true);
        } else {
            value["entries"][0]["receipt"]
                .as_object_mut()
                .unwrap()
                .remove("result");
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(
            Staging::load(&path, "session"),
            Err(IvyErrorCode::Storage)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    let mut revoked = binding;
    revoked.revoked = true;
    assert!(stage.latch_denial(&revoked, now).unwrap());
    stage.save(&path).unwrap();
    let saved = Staging::load(&path, "session").unwrap();
    assert!(saved.entries[0].withheld && saved.entries[0].receipt.result.is_none());
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}
