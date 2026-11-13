use super::*;
use std::sync::{Arc, Mutex, atomic::Ordering};
const ID: &str = "00000000-0000-0000-0000-000000000001";

fn request(snapshot: &SpeechSnapshot) -> SpeechStopRequest {
    SpeechStopRequest {
        version: 1,
        epoch: snapshot.epoch.clone(),
        target: Some(SpeechStopTarget {
            operation_id: snapshot.operation_id.clone().unwrap(),
            operation_instance: snapshot.operation_instance.clone().unwrap(),
        }),
    }
}

#[test]
fn same_id_epoch_replacement_and_other_host_are_not_targeted_by_old_ack() {
    let directory = std::env::temp_dir().join(format!("stellar-targeted-{}", std::process::id()));
    let host = SpeechHost::new(directory.clone(), Arc::new(|_| {}));
    let first = host
        .reserve(ID.into(), "0", SpeechState::Transcribing)
        .unwrap();
    let ack = first.admitted.clone();
    host.settle(&first, Ok(String::new())).unwrap();
    let second = host
        .reserve(ID.into(), "0", SpeechState::Transcribing)
        .unwrap();
    let before = host.snapshot().unwrap();
    host.stop_request(request(&ack)).unwrap();
    assert!(!second.cancelled.load(Ordering::SeqCst));
    assert_eq!(host.snapshot().unwrap().revision, before.revision);
    let other = SpeechHost::new(directory, Arc::new(|_| {}));
    let foreign = other
        .reserve(ID.into(), "0", SpeechState::Transcribing)
        .unwrap();
    other.stop_request(request(&before)).unwrap();
    assert!(!foreign.cancelled.load(Ordering::SeqCst));
    host.stop_request(request(&before)).unwrap();
    assert!(second.cancelled.load(Ordering::SeqCst));
    assert_eq!(host.snapshot().unwrap().epoch, "0");
    host.shutdown().unwrap();
    other.shutdown().unwrap();
}

#[test]
fn speak_ack_is_original_reservation_even_after_reentrant_replacement() {
    let holder = Arc::new(Mutex::new(None::<SpeechHost>));
    let captured = holder.clone();
    let directory = std::env::temp_dir().join(format!("stellar-ack-{}", std::process::id()));
    let host = SpeechHost::new(
        directory.clone(),
        Arc::new(move |snapshot| {
            if snapshot.state == SpeechState::Synthesizing {
                let host = captured.lock().unwrap().clone().unwrap();
                host.stop_epoch("0").unwrap();
                host.reserve(ID.into(), "1", SpeechState::Transcribing)
                    .unwrap();
            }
        }),
    );
    *holder.lock().unwrap() = Some(host.clone());
    let ack = host
        .speak(SpeechSpeakRequest {
            version: 1,
            epoch: "0".into(),
            utterance_id: ID.into(),
            text: "Never dispatched".into(),
        })
        .unwrap();
    assert_eq!(ack.epoch, "0");
    assert_eq!(ack.state, SpeechState::Synthesizing);
    assert_ne!(
        ack.operation_instance,
        host.snapshot().unwrap().operation_instance
    );
    host.stop_request(request(&ack)).unwrap();
    assert_eq!(host.snapshot().unwrap().state, SpeechState::Transcribing);
    host.shutdown().unwrap();
    *holder.lock().unwrap() = None;
    if directory.exists() {
        std::fs::remove_dir(directory).unwrap();
    }
}

#[test]
fn omitted_target_preserves_human_global_stop_but_null_or_malformed_never_downgrades() {
    let host = SpeechHost::new(std::env::temp_dir(), Arc::new(|_| {}));
    for value in [
        serde_json::json!({"version":1,"epoch":"0","target":null}),
        serde_json::json!({"version":1,"epoch":"0","target":{}}),
    ] {
        assert!(validation::decode::<SpeechStopRequest>(Some(value)).is_err());
    }
    let request = validation::decode(Some(serde_json::json!({"version":1,"epoch":"0"}))).unwrap();
    assert_eq!(host.stop_request(request).unwrap().epoch, "1");
    host.shutdown().unwrap();
}
