use super::*;

fn app(name: &str, at: u64) -> AwarenessApp {
    AwarenessApp {
        app: name.into(),
        title: "Racing game".into(),
        observed_at_ms: at.to_string(),
    }
}

#[test]
fn last_other_app_is_retained_separately_and_old_observations_expire() {
    let mut state = State::new(true);
    assert!(state.observe(
        0,
        Ok(app("game.exe", 1_000)),
        Some(Ok(Some(AwarenessMedia {
            title: "Track".into(),
            artist: "Artist".into(),
            playing: true,
            observed_at_ms: "1000".into()
        })))
    ));
    state.observe(0, Ok(app("stellar-desktop.exe", 2_000)), None);
    state.snapshot.media_observed_at_ms = Some("1000".into());
    let context: serde_json::Value =
        serde_json::from_str(&state.context("1", 3_000).unwrap()).unwrap();
    assert_eq!(context["foreground"]["app"], "stellar-desktop.exe");
    assert_eq!(context["last_external"]["app"], "game.exe");
    assert_eq!(context["spotify"]["playing"], true);
    let expired: serde_json::Value =
        serde_json::from_str(&state.context("1", 400_000).unwrap()).unwrap();
    assert!(expired["foreground"].is_null());
    assert!(expired["last_external"].is_null());
    assert!(expired["spotify"].is_null());
}

#[test]
fn pause_and_shutdown_fence_inflight_observations_and_clear_private_cache() {
    let mut state = State::new(true);
    state.observe(0, Ok(app("game.exe", 100)), None);
    state.enabled(false);
    assert!(!state.observe(0, Ok(app("old.exe", 200)), None));
    assert!(state.context("0", 200).is_none());
    assert!(state.snapshot.last_external.is_none());
    state.enabled(true);
    assert!(!state.observe(0, Ok(app("old.exe", 200)), None));
    assert!(state.observe(2, Ok(app("new.exe", 300)), None));
    state.stopped = true;
    assert!(!state.observe(2, Ok(app("late.exe", 400)), None));
    assert!(state.context("0", 400).is_none());
}

#[test]
fn workspace_must_belong_to_request_epoch_and_be_fresh() {
    let mut state = State::new(true);
    state.snapshot.workspace = Some(AwarenessWorkspace {
        version: 1,
        epoch: "3".into(),
        panes: vec![],
    });
    state.workspace_at = 100;
    for epoch in ["2", "3"] {
        let value: serde_json::Value =
            serde_json::from_str(&state.context(epoch, 200).unwrap()).unwrap();
        assert!(value["workspace"].is_object());
    }
    for (epoch, at) in [("4", 200), ("3", 16_000), ("3", 99)] {
        let value: serde_json::Value =
            serde_json::from_str(&state.context(epoch, at).unwrap()).unwrap();
        assert!(value["workspace"].is_null());
    }
}

#[test]
fn source_failures_never_preserve_current_foreground_or_playback() {
    let mut state = State::new(true);
    state.observe(0, Ok(app("game.exe", 100)), Some(Ok(None)));
    state.observe(0, Err(()), Some(Err(())));
    assert_eq!(state.snapshot.app_health, AwarenessHealth::Unavailable);
    assert_eq!(state.snapshot.media_health, AwarenessHealth::Unavailable);
    assert!(state.snapshot.foreground.is_none());
    assert!(state.snapshot.spotify.is_none());
}

#[test]
fn native_labels_and_workspace_validation_bound_external_metadata() {
    assert_eq!(label("a\nb\0c", 2), "ab");
    let mut workspace = AwarenessWorkspace {
        version: 1,
        epoch: "2".into(),
        panes: vec![AwarenessPane {
            title: "Race".into(),
            surface: "browser".into(),
            selected: true,
            minimized: false,
        }],
    };
    assert!(workspace_valid(&workspace));
    workspace.panes[0].title = "a\nb".into();
    assert!(!workspace_valid(&workspace));
    workspace.panes.clear();
    workspace.version = 2;
    assert!(!workspace_valid(&workspace));
    assert!(!recent("200", 100, 5_000));
}

#[test]
fn maximum_unicode_metadata_is_bounded_before_combining_with_user_request() {
    let mut state = State::new(true);
    let observed = AwarenessApp {
        app: "🪐".repeat(120),
        title: "🪐".repeat(160),
        observed_at_ms: "100".into(),
    };
    state.snapshot.foreground = Some(observed.clone());
    state.snapshot.last_external = Some(observed);
    state.snapshot.app_health = AwarenessHealth::Available;
    state.snapshot.media_health = AwarenessHealth::Available;
    state.snapshot.media_observed_at_ms = Some("100".into());
    state.snapshot.spotify = Some(AwarenessMedia {
        title: "🪐".repeat(160),
        artist: "🪐".repeat(160),
        playing: true,
        observed_at_ms: "100".into(),
    });
    state.snapshot.workspace = Some(AwarenessWorkspace {
        version: 1,
        epoch: "1".into(),
        panes: (0..8)
            .map(|_| AwarenessPane {
                title: "🪐".repeat(80),
                surface: "browser".into(),
                selected: false,
                minimized: false,
            })
            .collect(),
    });
    state.workspace_at = 100;
    let context = state.context("1", 200).unwrap();
    assert!(context.len() <= 6144);
    let value: serde_json::Value = serde_json::from_str(&context).unwrap();
    assert!(value["foreground"].is_object());
    assert!(value["workspace"]["panes"].as_array().unwrap().len() < 8);
}
