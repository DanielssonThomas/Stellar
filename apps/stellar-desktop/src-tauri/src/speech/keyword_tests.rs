use super::*;
use std::sync::Arc;

fn request() -> KeywordRequest {
    KeywordRequest {
        version: 1,
        epoch: "0".into(),
        stream_id: "bounded-stream".into(),
        sequence: 0,
        pcm: vec![0; 640],
        threshold: 0.008,
        mode: KeywordMode::Passive,
    }
}
fn host() -> SpeechHost {
    SpeechHost::new(
        std::env::temp_dir().join("stellar-keyword-contract"),
        Arc::new(|_| {}),
    )
}

#[test]
fn invalid_keyword_frames_never_start_an_engine() {
    let host = host();
    for (kind, code) in [
        (0, SpeechError::UnsupportedVersion),
        (1, SpeechError::MalformedRequest),
        (2, SpeechError::MalformedRequest),
        (3, SpeechError::MalformedRequest),
        (4, SpeechError::MalformedRequest),
    ] {
        let mut request = request();
        match kind {
            0 => request.version = 2,
            1 => request.pcm.clear(),
            2 => request.pcm.push(0),
            3 => request.threshold = f32::NAN,
            _ => request.stream_id = "../model".into(),
        }
        assert!(matches!(host.keywords(request), Err(error) if error == code));
    }
}

#[test]
fn stale_keyword_epochs_shutdown_and_playback_are_fenced() {
    let host = host();
    host.inner.view.lock().unwrap().snapshot.state = SpeechState::Speaking;
    assert!(matches!(host.keywords(request()), Err(SpeechError::Busy)));
    host.stop_epoch("0").unwrap();
    assert!(matches!(
        host.keywords(request()),
        Err(SpeechError::Cancelled)
    ));
    let mut fresh = request();
    fresh.epoch = "1".into();
    host.shutdown().unwrap();
    assert!(matches!(host.keywords(fresh), Err(SpeechError::Cancelled)));
}

#[test]
fn invalid_worker_detections_are_rejected_before_dispatch() {
    for frame in [
        json!({"sequence":0}),
        json!({"sequence":1,"detection":null}),
        json!({"sequence":0,"detection":{"command":"clear","end_sample":640}}),
        json!({"sequence":0,"detection":{"command":"ivy","end_sample":-1}}),
        json!({"sequence":0,"detection":null,"text":"unexpected"}),
    ] {
        assert!(matches!(
            decode_reply(frame, &request()),
            Err(SpeechError::Protocol)
        ));
    }
    let mut active = request();
    active.mode = KeywordMode::Listening;
    assert!(matches!(
        decode_reply(
            json!({"sequence":0,"detection":{"command":"prompt cancel","end_sample":640}}),
            &active
        ),
        Err(SpeechError::Protocol)
    ));
    assert!(decode_reply(json!({"sequence":0,"detection":null}), &active).is_ok());
    active.mode = KeywordMode::Composing;
    for command in ["prompt", "reload mcp"] {
        assert!(matches!(
            decode_reply(
                json!({"sequence":0,"detection":{"command":command,"end_sample":640}}),
                &active
            ),
            Err(SpeechError::Protocol)
        ));
    }
}

#[test]
fn sensitive_passive_mode_can_only_report_wake_not_mutating_commands() {
    let mut request = request();
    request.mode = KeywordMode::PassiveSensitive;
    for command in [
        "clear",
        "done",
        "prompt",
        "new session",
        "reload mcp",
        "prompt cancel",
    ] {
        assert!(matches!(
            decode_reply(
                json!({"sequence":0,"detection":{"command":command,"end_sample":640}}),
                &request
            ),
            Err(SpeechError::Protocol)
        ));
    }
    assert!(
        decode_reply(
            json!({"sequence":0,"detection":{"command":"ivy","end_sample":640}}),
            &request
        )
        .is_ok()
    );
}
