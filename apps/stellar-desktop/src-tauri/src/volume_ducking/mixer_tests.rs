use super::{
    ducking_tests::{endpoint, near},
    mixer::Mixer,
    *,
};
use std::sync::{Arc, Mutex};

fn session(id: &str, process: u32, level: &Arc<Mutex<f32>>) -> Session {
    Session {
        id: id.into(),
        process,
        endpoint: endpoint(level),
    }
}

#[test]
fn excludes_actual_speaker_and_host_across_devices_and_discovers_new_audio() {
    let speaker = Arc::new(Mutex::new(0.8));
    let host = Arc::new(Mutex::new(0.9));
    let music = Arc::new(Mutex::new(0.7));
    let game = Arc::new(Mutex::new(0.5));
    let mut mixer = Mixer::default();
    mixer.discover(
        vec![
            session("a/ivy", 5, &speaker),
            session("b/host", std::process::id(), &host),
            session("a/music", 6, &music),
        ],
        5,
    );
    mixer.tick(true, Duration::from_millis(800), 5);
    near(&speaker, 0.8);
    near(&host, 0.9);
    near(&music, 0.14);
    mixer.discover(
        vec![
            session("a/ivy", 5, &speaker),
            session("a/music", 6, &music),
            session("b/game", 7, &game),
        ],
        5,
    );
    mixer.tick(true, Duration::from_millis(800), 5);
    near(&music, 0.14);
    near(&game, 0.1);
    mixer.tick(false, Duration::from_millis(800), 5);
    near(&music, 0.7);
    near(&game, 0.5);
    near(&speaker, 0.8);
    assert!(mixer.is_empty());
}

#[test]
fn rediscovery_never_reclaims_manual_overrides_until_interaction_ends() {
    let music = Arc::new(Mutex::new(0.7));
    let mut mixer = Mixer::default();
    mixer.discover(vec![session("music", 6, &music)], 5);
    mixer.tick(true, Duration::from_millis(800), 5);
    *music.lock().unwrap() = 0.4;
    mixer.tick(true, TICK, 5);
    mixer.discover(vec![session("music", 6, &music)], 5);
    mixer.tick(true, Duration::from_secs(1), 5);
    near(&music, 0.4);
    mixer.tick(false, TICK, 5);
    mixer.discover(vec![session("music", 6, &music)], 5);
    mixer.tick(true, Duration::from_millis(800), 5);
    near(&music, 0.08);
    drop(mixer);
    near(&music, 0.4);
}

#[test]
fn removal_and_speaker_identity_change_restore_the_retained_session() {
    let level = Arc::new(Mutex::new(0.6));
    for replace in [false, true] {
        let mut mixer = Mixer::default();
        mixer.discover(vec![session("audio", 6, &level)], 5);
        mixer.tick(true, Duration::from_millis(800), 5);
        near(&level, 0.12);
        if replace {
            mixer.tick(true, TICK, 6);
        } else {
            mixer.discover(vec![], 5);
        }
        near(&level, 0.6);
    }
}

#[test]
fn system_session_zero_is_not_confused_with_uninitialized_speaker() {
    let level = Arc::new(Mutex::new(0.5));
    let mut mixer = Mixer::default();
    mixer.discover(vec![session("system", 0, &level)], 0);
    mixer.tick(true, Duration::from_millis(800), 0);
    near(&level, 0.1);
    drop(mixer);
    near(&level, 0.5);
}
