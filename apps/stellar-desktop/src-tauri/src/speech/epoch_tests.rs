use super::*;
use serde_json::json;

const ID: &str = "00000000-0000-0000-0000-000000000001";
fn fixture() -> SpeechHost {
    SpeechHost::new(
        std::env::temp_dir().join("stellar-speech-epochs"),
        Arc::new(|_| {}),
    )
}

#[test]
fn stop_before_request_decoding_rejects_both_late_command_kinds() {
    let host = fixture();
    let queued =
        json!({"version":1,"epoch":"0","utterance_id":ID,"sample_rate_hz":16000,"pcm":[0]});
    assert_eq!(host.stop_epoch("0").unwrap().epoch, "1");
    let request = validation::decode(Some(queued)).unwrap();
    assert!(matches!(
        host.transcribe(request),
        Err(SpeechError::Cancelled)
    ));
    assert!(matches!(
        host.speak(SpeechSpeakRequest {
            version: 1,
            epoch: "0".into(),
            utterance_id: ID.into(),
            text: "stale".into()
        }),
        Err(SpeechError::Cancelled)
    ));
    assert!(host.inner.view.lock().unwrap().active.is_none());
    assert_eq!(host.snapshot().unwrap().operation_id, None);
}

#[test]
fn acknowledged_stop_fences_a_request_paused_before_admission() {
    let host = fixture();
    let (ready, waiting) = std::sync::mpsc::sync_channel(1);
    let (release, resume) = std::sync::mpsc::sync_channel(1);
    let delayed = host.clone();
    let thread = std::thread::spawn(move || {
        let request = SpeechTranscribeRequest {
            version: 1,
            epoch: "0".into(),
            utterance_id: ID.into(),
            sample_rate_hz: 16000,
            pcm: vec![0; 320000],
        };
        validation::transcribe(&request).unwrap();
        ready.send(()).unwrap();
        resume.recv().unwrap();
        assert!(matches!(
            delayed.transcribe(request),
            Err(SpeechError::Cancelled)
        ));
    });
    waiting.recv().unwrap();
    host.stop_epoch("0").unwrap();
    release.send(()).unwrap();
    thread.join().unwrap();
    assert!(host.inner.view.lock().unwrap().active.is_none());
}

#[test]
fn stale_or_future_stop_cannot_cancel_the_new_epoch_owner() {
    let host = fixture();
    host.stop_epoch("0").unwrap();
    let operation = host
        .reserve(ID.into(), "1", SpeechState::Transcribing)
        .unwrap();
    assert_eq!(host.stop_epoch("0").unwrap().epoch, "1");
    assert!(matches!(
        host.stop_epoch("2"),
        Err(SpeechError::MalformedRequest)
    ));
    assert!(current(&host.inner.view.lock().unwrap(), &operation));
    assert!(!operation.cancelled.load(Ordering::SeqCst));
    assert_eq!(host.stop_epoch("1").unwrap().epoch, "2");
    assert!(operation.cancelled.load(Ordering::SeqCst));
    assert_eq!(host.stop_epoch("1").unwrap().epoch, "2");
    let replacement = host
        .reserve(ID.into(), "2", SpeechState::Transcribing)
        .unwrap();
    assert!(!replacement.cancelled.load(Ordering::SeqCst));
    host.shutdown().unwrap();
}

#[test]
fn failed_cleanup_requires_current_epoch_retry_and_keeps_admission_occupied() {
    let root = std::env::temp_dir().join(format!(
        "stellar-speech-epoch-cleanup-{}",
        std::process::id()
    ));
    let host = SpeechHost::new(root.clone(), Arc::new(|_| {}));
    let operation = host
        .reserve(ID.into(), "0", SpeechState::Synthesizing)
        .unwrap();
    let blocked = operation
        .scratch
        .as_ref()
        .unwrap()
        .output()
        .with_file_name("blocked");
    std::fs::write(&blocked, b"cleanup failure fixture").unwrap();
    assert!(matches!(
        host.stop_epoch("0"),
        Err(SpeechError::Unavailable)
    ));
    assert_eq!(host.snapshot().unwrap().epoch, "1");
    assert!(matches!(
        host.reserve(ID.into(), "1", SpeechState::Transcribing),
        Err(SpeechError::Busy)
    ));
    host.stop_epoch("0").unwrap();
    assert!(current(&host.inner.view.lock().unwrap(), &operation));
    std::fs::remove_file(blocked).unwrap();
    assert_eq!(host.stop_epoch("1").unwrap().epoch, "2");
    assert!(host.inner.view.lock().unwrap().active.is_none());
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn epoch_wire_format_is_exact_and_never_wraps() {
    for value in ["", "01", "+1", "-1", " 1", "18446744073709551616"] {
        assert_eq!(validation::epoch(value), Err(SpeechError::MalformedRequest));
    }
    assert_eq!(validation::epoch("18446744073709551615").unwrap(), u64::MAX);
    let host = fixture();
    {
        let mut view = host.inner.view.lock().unwrap();
        view.epoch = u64::MAX;
        view.snapshot.epoch = u64::MAX.to_string();
    }
    assert!(matches!(
        host.stop_epoch("18446744073709551615"),
        Err(SpeechError::Unavailable)
    ));
    assert_eq!(host.snapshot().unwrap().epoch, "18446744073709551615");
}
