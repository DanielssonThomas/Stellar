use super::{contracts::*, dsp::Analyzer, host::MusicHost};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

fn tone(frequency: f32) -> MusicLevels {
    let mut analyzer = Analyzer::new(48000);
    for index in 0..4800 {
        analyzer.sample(0.1 * (std::f32::consts::TAU * frequency * index as f32 / 48000.0).sin());
    }
    analyzer.take()
}

#[test]
fn separates_broad_bands_and_bounds_invalid_and_silent_samples() {
    let bass = tone(80.0);
    let mid = tone(1000.0);
    let treble = tone(10000.0);
    assert!(bass.bass > bass.mid && bass.bass > bass.treble);
    assert!((super::dsp::stereo_levels(bass, bass).level - bass.level).abs() < 0.0001);
    assert!(mid.mid > mid.bass && mid.mid > mid.treble);
    assert!(treble.treble > treble.bass && treble.treble > treble.mid);
    let mut analyzer = Analyzer::new(48000);
    analyzer.sample(f32::NAN);
    analyzer.sample(f32::INFINITY);
    assert_eq!(analyzer.take().level, 0.0);
    analyzer.sample(100.0);
    assert_eq!(analyzer.take().level, 1.0);
    assert_eq!(analyzer.take().level, 0.0);
}

#[test]
fn request_is_versioned_and_rejects_unknown_fields() {
    use serde_json::json;
    assert_eq!(
        super::decode_request(None).unwrap_err(),
        MusicError::Malformed
    );
    assert_eq!(
        super::decode_request(Some(json!({"version":2,"enabled":true}))).unwrap_err(),
        MusicError::UnsupportedVersion
    );
    assert_eq!(
        super::decode_request(Some(json!({"version":1,"enabled":true,"device":"mic"})))
            .unwrap_err(),
        MusicError::Malformed
    );
    assert!(
        !super::decode_request(Some(json!({"version":1,"enabled":false})))
            .unwrap()
            .enabled
    );
    assert_eq!(
        serde_json::to_value(MusicStatus::Capturing).unwrap(),
        "capturing"
    );
}

#[test]
fn owns_one_capture_and_fences_old_sinks_after_stop_and_restart() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let published = events.clone();
    let sinks = Arc::new(Mutex::new(Vec::new()));
    let saved_sinks = sinks.clone();
    let starts = Arc::new(AtomicUsize::new(0));
    let captures = starts.clone();
    let host = MusicHost::with_capture(
        Arc::new(move |event| published.lock().unwrap().push(event)),
        Arc::new(move |stop, sink| {
            captures.fetch_add(1, Ordering::SeqCst);
            saved_sinks.lock().unwrap().push(sink.clone());
            sink(None);
            while !stop.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(())
        }),
    );
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    host.set_enabled(true).unwrap();
    for _ in 0..1000 {
        if !sinks.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    host.set_enabled(true).unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let stopped = host.set_enabled(false).unwrap();
    let count = events.lock().unwrap().len();
    sinks.lock().unwrap()[0](Some(super::host::MusicFrame {
        levels: MusicLevels {
            level: 1.0,
            ..Default::default()
        },
        tone: Some(69),
    }));
    assert_eq!(events.lock().unwrap().len(), count);
    assert_eq!(stopped.status, MusicStatus::Idle);
    assert_eq!(stopped.levels.level, 0.0);
    assert_eq!(stopped.tone, None);
    host.set_enabled(true).unwrap();
    host.shutdown();
    let events = events.lock().unwrap();
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].sequence.parse::<u64>().unwrap()
                < pair[1].sequence.parse::<u64>().unwrap())
    );
    assert_eq!(events.last().unwrap().status, MusicStatus::Idle);
}

#[test]
fn unavailable_capture_returns_to_neutral_and_can_retry() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let published = events.clone();
    let host = MusicHost::with_capture(
        Arc::new(move |event| published.lock().unwrap().push(event)),
        Arc::new(|_, _| Err(())),
    );
    host.set_enabled(true).unwrap();
    for _ in 0..1000 {
        if events
            .lock()
            .unwrap()
            .last()
            .is_some_and(|event| event.status == MusicStatus::Unavailable)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        events.lock().unwrap().last().unwrap().status,
        MusicStatus::Unavailable
    );
    host.set_enabled(false).unwrap();
}
