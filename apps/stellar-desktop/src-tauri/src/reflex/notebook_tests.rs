use super::*;
use crate::reflex::contracts::ReflexMediaAction;

fn fixture() -> (std::path::PathBuf, ReflexMediaRequest, ReflexMediaState) {
    let root = std::env::temp_dir().join(format!(
        "ivy-notebook-native-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let folder = root.join("private");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        root.join("config.json"),
        r#"{"automatic_capture":true,"paused_until":0}"#,
    )
    .unwrap();
    let request = ReflexMediaRequest {
        version: 1,
        input_id: "test-request".into(),
        ticket: "1".into(),
        action: ReflexMediaAction::Next,
    };
    let state = ReflexMediaState {
        ticket: "1".into(),
        player: Some("Fixture player".into()),
        title: Some("Fixture song".into()),
        playing: true,
        volume: Some(50),
        muted: Some(false),
        endpoint_id: Some("must-not-export".into()),
        actions: vec!["next".into()],
    };
    (folder, request, state)
}

#[test]
fn absent_notebook_does_not_create_spool() {
    let (folder, request, state) = fixture();
    write_receipt(&folder, &request, &state, &ReflexMediaResult::Confirmed).unwrap();
    assert!(!folder.join("reflex").exists());
    fs::remove_dir_all(folder.parent().unwrap()).unwrap();
}

#[test]
fn confirmed_uncertain_and_rejected_are_distinct_private_receipts() {
    let (folder, mut request, state) = fixture();
    fs::write(folder.join("enabled"), b"ivy-notebook-reflex-v1\n").unwrap();
    for (id, result, expected) in [
        ("confirmed", ReflexMediaResult::Confirmed, "confirmed"),
        ("uncertain", ReflexMediaResult::Uncertain, "uncertain"),
        ("rejected", ReflexMediaResult::Rejected, "rejected"),
    ] {
        request.input_id = id.into();
        write_receipt(&folder, &request, &state, &result).unwrap();
        write_receipt(&folder, &request, &state, &result).unwrap();
        let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
        let raw = fs::read_to_string(folder.join(format!("reflex/{digest}.json"))).unwrap();
        let data: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(data["outcome"], expected);
        assert_eq!(data["context_title"], "Fixture song");
        assert!(!raw.contains("must-not-export"));
        assert!(!raw.contains("volume"));
        println!("STELLAR_NOTEBOOK_FIXTURE {raw}");
    }
    assert_eq!(fs::read_dir(folder.join("reflex")).unwrap().count(), 3);
    fs::remove_dir_all(folder.parent().unwrap()).unwrap();
}

#[test]
fn disabled_capture_writes_nothing_and_capacity_never_evicts() {
    let (folder, request, state) = fixture();
    fs::write(folder.join("enabled"), b"ivy-notebook-reflex-v1\n").unwrap();
    fs::write(
        folder.parent().unwrap().join("config.json"),
        r#"{"automatic_capture":false,"paused_until":0}"#,
    )
    .unwrap();
    write_receipt(&folder, &request, &state, &ReflexMediaResult::Confirmed).unwrap();
    assert!(!folder.join("reflex").exists());
    fs::write(
        folder.parent().unwrap().join("config.json"),
        r#"{"automatic_capture":true,"paused_until":0}"#,
    )
    .unwrap();
    fs::create_dir(folder.join("reflex")).unwrap();
    for i in 0..256 {
        fs::write(folder.join(format!("reflex/{i}.json")), b"{}").unwrap();
    }
    assert!(write_receipt(&folder, &request, &state, &ReflexMediaResult::Confirmed).is_err());
    assert_eq!(fs::read_dir(folder.join("reflex")).unwrap().count(), 256);
    let wakes = std::cell::Cell::new(0);
    persist_and_wake(
        &folder,
        &request,
        &state,
        &ReflexMediaResult::Confirmed,
        || wakes.set(wakes.get() + 1),
    );
    assert_eq!(
        wakes.get(),
        1,
        "A full spool must still wake its recovery worker"
    );
    assert_eq!(fs::read_dir(folder.join("reflex")).unwrap().count(), 256);
    fs::remove_dir_all(folder.parent().unwrap()).unwrap();
}

#[test]
fn inspection_and_system_volume_do_not_capture_unrelated_playback() {
    let (folder, mut request, state) = fixture();
    fs::write(folder.join("enabled"), b"ivy-notebook-reflex-v1\n").unwrap();
    request.action = ReflexMediaAction::Inspect;
    write_receipt(&folder, &request, &state, &ReflexMediaResult::Confirmed).unwrap();
    assert!(!folder.join("reflex").exists());
    request.action = ReflexMediaAction::VolumeUp;
    write_receipt(&folder, &request, &state, &ReflexMediaResult::Confirmed).unwrap();
    let path = fs::read_dir(folder.join("reflex"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let data: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert!(data["context_title"].is_null());
    assert!(data["player"].is_null());
    fs::remove_dir_all(folder.parent().unwrap()).unwrap();
}
