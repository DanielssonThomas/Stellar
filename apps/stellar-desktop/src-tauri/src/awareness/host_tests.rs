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

#[test]
fn deferred_context_lease_rereads_freshness_and_cannot_survive_pause_resume() {
    let shared = Arc::new((Mutex::new(State::new(true)), Condvar::new()));
    let seed = |name: &str, stamp: u64| {
        let mut state = shared.0.lock().unwrap();
        let generation = state.generation;
        state.observe(
            generation,
            Ok(AwarenessApp {
                app: name.into(),
                title: "Synthetic".into(),
                observed_at_ms: stamp.to_string(),
            }),
            None,
        );
    };
    seed("before.exe", state::now());
    let provide = provider(shared.clone());
    let pending = provide("0").unwrap();
    seed("after.exe", state::now());
    assert!(pending().unwrap().contains("after.exe"));
    seed("expired.exe", state::now().saturating_sub(6_000));
    let expired: serde_json::Value = serde_json::from_str(&pending().unwrap()).unwrap();
    assert!(expired["foreground"].is_null());
    {
        let mut state = shared.0.lock().unwrap();
        state.enabled(false);
        state.enabled(true);
    }
    seed("resumed.exe", state::now());
    assert!(pending().is_none());
    assert!(provide("0").unwrap()().unwrap().contains("resumed.exe"));
}
