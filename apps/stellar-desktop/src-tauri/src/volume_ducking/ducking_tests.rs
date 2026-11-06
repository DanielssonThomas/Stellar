use super::{
    ramp::{Progress, Ramp},
    *,
};
use std::sync::{Arc, Mutex};

struct Fake {
    level: Arc<Mutex<f32>>,
    current: bool,
    fail: bool,
}

impl Endpoint for Fake {
    fn read(&self) -> Result<f32, ()> {
        Ok(*self.level.lock().unwrap())
    }
    fn write(&self, level: f32) -> Result<(), ()> {
        if self.fail {
            Err(())
        } else {
            *self.level.lock().unwrap() = level;
            Ok(())
        }
    }
    fn is_current(&self) -> bool {
        self.current
    }
}

pub(super) fn endpoint(level: &Arc<Mutex<f32>>) -> Box<dyn Endpoint> {
    Box::new(Fake {
        level: level.clone(),
        current: true,
        fail: false,
    })
}

pub(super) fn near(level: &Arc<Mutex<f32>>, expected: f32) {
    assert!((*level.lock().unwrap() - expected).abs() < 0.0001);
}

#[test]
fn fades_and_reverses_without_cumulative_ducking() {
    let level = Arc::new(Mutex::new(0.75));
    let mut ramp = Ramp::new(endpoint(&level)).unwrap();
    ramp.tick(true, Duration::from_millis(400));
    near(&level, 0.45);
    ramp.tick(true, Duration::from_millis(400));
    near(&level, 0.15);
    for _ in 0..30 {
        ramp.tick(true, TICK);
    }
    near(&level, 0.15);
    ramp.tick(false, Duration::from_millis(400));
    near(&level, 0.45);
    ramp.tick(true, Duration::from_millis(200));
    near(&level, 0.30);
    assert!(matches!(
        ramp.tick(false, Duration::from_secs(1)),
        Progress::Restored
    ));
    near(&level, 0.75);
}

#[test]
fn respects_manual_adjustments_including_during_restoration() {
    for active in [true, false] {
        let level = Arc::new(Mutex::new(0.8));
        let mut ramp = Ramp::new(endpoint(&level)).unwrap();
        ramp.tick(true, Duration::from_secs(1));
        *level.lock().unwrap() = 0.42;
        assert!(matches!(ramp.tick(active, TICK), Progress::Overridden));
        drop(ramp);
        near(&level, 0.42);
    }
}

#[test]
fn zero_volume_and_failed_writes_never_raise_the_original_level() {
    let level = Arc::new(Mutex::new(0.0));
    let mut ramp = Ramp::new(endpoint(&level)).unwrap();
    ramp.tick(true, Duration::from_secs(1));
    near(&level, 0.0);
    drop(ramp);
    let level = Arc::new(Mutex::new(0.6));
    let mut ramp = Ramp::new(Box::new(Fake {
        level: level.clone(),
        current: true,
        fail: true,
    }))
    .unwrap();
    ramp.tick(true, Duration::from_secs(1));
    near(&level, 0.6);
    drop(ramp);
    near(&level, 0.6);
}

#[test]
fn endpoint_replacement_and_drop_restore_the_retained_endpoint() {
    let level = Arc::new(Mutex::new(0.65));
    let mut ramp = Ramp::new(Box::new(Fake {
        level: level.clone(),
        current: false,
        fail: false,
    }))
    .unwrap();
    ramp.tick(true, Duration::from_secs(1));
    assert!(!ramp.is_current());
    drop(ramp);
    near(&level, 0.65);
}

#[test]
fn abandoned_renderer_lease_and_shutdown_restore_volume() {
    for abandon in [true, false] {
        let level = Arc::new(Mutex::new(0.7));
        let copy = level.clone();
        let (send, receive) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            run_with(
                receive,
                || {
                    Ok(vec![Session {
                        id: "test".into(),
                        process: u32::MAX,
                        endpoint: endpoint(&copy),
                    }])
                },
                Arc::new(AtomicU32::new(0)),
            )
        });
        send.send(Message::Active(true)).unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        near(&level, 0.14);
        if abandon {
            std::thread::sleep(LEASE + Duration::from_millis(100));
            near(&level, 0.7);
        }
        send.send(Message::Shutdown).unwrap();
        thread.join().unwrap();
        near(&level, 0.7);
    }
}

#[test]
fn shutdown_seals_future_dispatch() {
    let host = VolumeDucking::default();
    host.shutdown();
    assert!(host.set_active(true).is_err());
}

#[test]
fn speaker_starting_during_enumeration_is_never_attenuated() {
    struct Watched {
        level: Arc<Mutex<f32>>,
        writes: Arc<Mutex<Vec<f32>>>,
    }
    impl Endpoint for Watched {
        fn read(&self) -> Result<f32, ()> {
            Ok(*self.level.lock().unwrap())
        }
        fn write(&self, value: f32) -> Result<(), ()> {
            self.writes.lock().unwrap().push(value);
            *self.level.lock().unwrap() = value;
            Ok(())
        }
        fn is_current(&self) -> bool {
            true
        }
    }
    let speaker = Arc::new(AtomicU32::new(0));
    let identity = speaker.clone();
    let level = Arc::new(Mutex::new(0.8));
    let observed = level.clone();
    let writes = Arc::new(Mutex::new(vec![]));
    let recording = writes.clone();
    let music = Arc::new(Mutex::new(0.7));
    let (send, receive) = mpsc::channel();
    let (scanned, ready) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut scans = 0;
        run_with(
            receive,
            || {
                scans += 1;
                let mut sessions = vec![Session {
                    id: "music".into(),
                    process: u32::MAX,
                    endpoint: endpoint(&music),
                }];
                if scans >= 2 {
                    identity.store(5, Ordering::Release);
                    sessions.push(Session {
                        id: "new-ivy".into(),
                        process: 5,
                        endpoint: Box::new(Watched {
                            level: observed.clone(),
                            writes: recording.clone(),
                        }),
                    });
                    if scans == 2 {
                        scanned.send(()).unwrap();
                    }
                }
                Ok(sessions)
            },
            speaker,
        );
    });
    send.send(Message::Active(true)).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    send.send(Message::Shutdown).unwrap();
    worker.join().unwrap();
    near(&level, 0.8);
    assert!(writes.lock().unwrap().is_empty());
}

#[test]
fn ducking_contract_rejects_unknown_fields_and_wrong_types() {
    use crate::speech::contracts::SpeechDuckingRequest;
    for value in [
        serde_json::json!({"version": 1, "active": "true"}),
        serde_json::json!({"version": 1, "active": true, "level": 0.5}),
        serde_json::json!({"active": true}),
    ] {
        assert!(serde_json::from_value::<SpeechDuckingRequest>(value).is_err());
    }
    let value = serde_json::json!({"version": 1, "active": true});
    let request: SpeechDuckingRequest = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
}
