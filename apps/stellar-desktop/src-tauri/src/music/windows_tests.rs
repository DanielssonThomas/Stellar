use super::{contracts::MusicStatus, host::MusicHost};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

#[test]
#[ignore = "requires a default Windows playback device and plays a quiet synthetic tone"]
fn live_loopback_reads_local_playback_and_releases_capture() {
    wasapi::initialize_mta().ok().unwrap();
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            wasapi::deinitialize();
        }
    }
    let _com = Com;
    let events = Arc::new(Mutex::new(Vec::new()));
    let published = events.clone();
    let host = MusicHost::new(Arc::new(move |event| published.lock().unwrap().push(event)));
    host.set_enabled(true).unwrap();
    for _ in 0..200 {
        if events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.status == MusicStatus::Capturing)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.status == MusicStatus::Capturing)
    );
    let enumerator = DeviceEnumerator::new().unwrap();
    let device = enumerator.get_default_device(&Direction::Render).unwrap();
    let mut client = device.get_iaudioclient().unwrap();
    client
        .initialize_client(
            &WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None),
            &Direction::Render,
            &StreamMode::PollingShared {
                autoconvert: true,
                buffer_duration_hns: 1_000_000,
            },
        )
        .unwrap();
    let render = client.get_audiorenderclient().unwrap();
    client.start_stream().unwrap();
    let began = Instant::now();
    let mut sample_index = 0;
    while began.elapsed() < Duration::from_millis(1200) {
        let frames = client.get_available_space_in_frames().unwrap().min(480) as usize;
        let mut bytes = Vec::with_capacity(frames * 8);
        for _ in 0..frames {
            let sample =
                0.06 * (std::f32::consts::TAU * 1000.0 * sample_index as f32 / 48000.0).sin();
            // Opposite stereo polarity also qualifies energy analysis without mono cancellation.
            bytes.extend_from_slice(&sample.to_le_bytes());
            bytes.extend_from_slice(&(-sample).to_le_bytes());
            sample_index += 1;
        }
        render.write_to_device(frames, &bytes, None).unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    client.stop_stream().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let stopped = host.set_enabled(false).unwrap();
    assert_eq!(stopped.status, MusicStatus::Idle);
    assert_eq!(stopped.levels.level, 0.0);
    assert_eq!(stopped.tone, None);
    let events = events.lock().unwrap();
    let active: Vec<_> = events
        .iter()
        .filter(|event| event.levels.level > 0.01)
        .collect();
    assert!(active.len() >= 10, "expected real loopback tone frames");
    assert!(
        active
            .iter()
            .any(|event| event.tone.is_some_and(|tone| (36..=95).contains(&tone)))
    );
    assert!(active.iter().any(
        |event| event.levels.mid > event.levels.bass && event.levels.mid > event.levels.treble
    ));
    println!(
        "MUSIC_LIVE_OK frames={} active={} max_level={:.3}",
        events.len(),
        active.len(),
        active
            .iter()
            .map(|event| event.levels.level)
            .fold(0.0_f32, f32::max)
    );
}
