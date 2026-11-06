use super::*;

#[test]
fn pause_preference_survives_restart_and_owned_worker_joins_on_shutdown() {
    let directory = std::env::temp_dir().join(format!(
        "stellar-awareness-test-{}-{}",
        std::process::id(),
        state::now()
    ));
    let host = AwarenessHost::new(&directory, Arc::new(|_| {}));
    let provider = host.provider();
    assert!(
        host.set_enabled(false)
            .is_ok_and(|snapshot| !snapshot.enabled && snapshot.foreground.is_none())
    );
    assert!(provider("0").is_none());
    host.shutdown();
    assert!(host.worker.lock().unwrap().is_none());
    assert_eq!(host.set_enabled(true), Err(AwarenessError::Unavailable));
    let restored = AwarenessHost::new(&directory, Arc::new(|_| {}));
    assert!(!restored.snapshot().unwrap().enabled);
    restored.set_enabled(true).unwrap();
    assert!(restored.snapshot().unwrap().enabled);
    restored.shutdown();
    assert!(restored.worker.lock().unwrap().is_none());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn malformed_workspace_does_not_replace_cache() {
    let directory = std::env::temp_dir().join(format!(
        "stellar-awareness-workspace-{}-{}",
        std::process::id(),
        state::now()
    ));
    let host = AwarenessHost::new(&directory, Arc::new(|_| {}));
    assert_eq!(
        host.workspace(AwarenessWorkspace {
            version: 2,
            epoch: "0".into(),
            panes: vec![]
        }),
        Err(AwarenessError::MalformedRequest)
    );
    assert!(host.snapshot().unwrap().workspace.is_none());
    host.shutdown();
}
