use super::{contracts::IvyErrorCode, update_store::*};

fn admission(id: &str, sequence: u64) -> Admission {
    Admission {
        id: id.into(),
        sequence,
        generation: 7,
        authority: 2,
    }
}

#[test]
fn duplicate_admission_must_preserve_its_canonical_identity() {
    for field in ["generation", "authority", "sequence"] {
        let mut store = Updates::default();
        store.admit(admission("same", 4)).unwrap();
        let before = serde_json::to_value(&store).unwrap();
        let mut changed = admission("same", 4);
        match field {
            "generation" => changed.generation += 1,
            "authority" => changed.authority += 1,
            _ => changed.sequence += 1,
        }
        assert_eq!(store.admit(changed), Err(IvyErrorCode::Protocol));
        assert_eq!(serde_json::to_value(&store).unwrap(), before);
        store.admit(admission("same", 4)).unwrap();
        assert_eq!(store.pending.len(), 1);
    }
}

#[test]
fn different_admissions_cannot_claim_the_same_canonical_sequence() {
    let mut store = Updates::default();
    store.admit(admission("first", 4)).unwrap();
    assert_eq!(
        store.admit(admission("second", 4)),
        Err(IvyErrorCode::Protocol)
    );
    assert_eq!(store.pending.len(), 1);
}

#[test]
fn stale_generation_does_not_hide_a_conflict_with_a_retained_id() {
    let mut store = Updates {
        floor_generation: 7,
        ..Updates::default()
    };
    let mut current = admission("current", 4);
    current.generation = 8;
    store.admit(current).unwrap();
    let before = serde_json::to_value(&store).unwrap();
    assert_eq!(
        store.admit(admission("current", 4)),
        Err(IvyErrorCode::Protocol)
    );
    assert_eq!(serde_json::to_value(&store).unwrap(), before);
    store.admit(admission("different-stale", 5)).unwrap();
    assert_eq!(serde_json::to_value(&store).unwrap(), before);
}

#[test]
fn completed_update_identity_cannot_be_reassigned_to_a_new_admission_sequence() {
    let mut store = Updates {
        settled_sequence: 4,
        completed: vec![super::contracts::IvyBackgroundUpdate {
            id: "done".into(),
            text: "Already verified".into(),
            speech_claim: None,
        }],
        ..Updates::default()
    };
    store.admit(admission("done", 4)).unwrap();
    assert_eq!(
        store.admit(admission("done", 5)),
        Err(IvyErrorCode::Protocol)
    );
    assert!(store.pending.is_empty());
}

#[test]
fn admission_ids_are_bounded_in_utf8_bytes_before_mutation() {
    for id in [String::new(), "x".repeat(513), "é".repeat(257)] {
        let mut store = Updates::default();
        assert_eq!(store.admit(admission(&id, 1)), Err(IvyErrorCode::Protocol));
        assert!(store.pending.is_empty());
    }
    Updates::default()
        .admit(admission(&"é".repeat(256), 1))
        .unwrap();
}

#[test]
fn backpressure_keeps_all_pending_admissions_and_reset_fence_still_ignores_old_work() {
    let mut store = Updates::default();
    for n in 1..=16 {
        store.admit(admission(&n.to_string(), n)).unwrap();
    }
    let before = serde_json::to_value(&store).unwrap();
    assert_eq!(
        store.admit(admission("overflow", 17)),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(serde_json::to_value(&store).unwrap(), before);
    let mut reset = Updates {
        floor_generation: 7,
        ..Updates::default()
    };
    reset.admit(admission("stale", 1)).unwrap();
    assert!(reset.pending.is_empty());
}

#[test]
fn malformed_retained_pending_state_is_not_repaired_or_published() {
    let dir = std::env::temp_dir().join(format!("stellar-update-store-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("updates.json");
    for pending in [
        vec![admission("", 4)],
        vec![admission("same", 4), admission("same", 5)],
        vec![admission("one", 4), admission("two", 4)],
        vec![admission("two", 5), admission("one", 4)],
    ] {
        let store = Updates {
            session: "session".into(),
            pending,
            ..Updates::default()
        };
        let bytes = serde_json::to_vec(&store).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(
            Updates::load(&path, "session"),
            Err(IvyErrorCode::Storage)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(store.save(&path), Err(IvyErrorCode::Storage));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
