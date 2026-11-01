use super::*;
use serde_json::json;

const ID: &str = "00000000-0000-0000-0000-000000000001";

#[test]
fn wire_requests_reject_wrong_versions_types_unknown_fields_and_pcm_bounds() {
    for value in [
        json!({"version":1,"utterance_id":ID,"sample_rate_hz":16000,"pcm":[0.5]}),
        json!({"version":1,"utterance_id":ID,"sample_rate_hz":16000,"pcm":[32768]}),
        json!({"version":1,"utterance_id":ID,"sample_rate_hz":16000,"pcm":[true]}),
        json!({"version":1,"utterance_id":ID,"sample_rate_hz":16000,"pcm":[0],"path":"untrusted"}),
    ] {
        assert!(decode::<SpeechTranscribeRequest>(Some(value)).is_err());
    }
    let mut request = SpeechTranscribeRequest {
        version: 2,
        utterance_id: ID.into(),
        sample_rate_hz: 16000,
        pcm: vec![0],
    };
    assert_eq!(transcribe(&request), Err(SpeechError::UnsupportedVersion));
    request.version = 1;
    request.pcm = vec![i16::MIN; 320000];
    assert!(transcribe(&request).is_ok());
    request.pcm.push(0);
    assert_eq!(transcribe(&request), Err(SpeechError::MalformedRequest));
    request.pcm.clear();
    assert_eq!(transcribe(&request), Err(SpeechError::MalformedRequest));
}

#[test]
fn speech_text_limit_counts_utf8_bytes_and_identity_is_canonical() {
    let mut request = SpeechSpeakRequest {
        version: 1,
        utterance_id: ID.into(),
        text: "界".repeat(1333),
    };
    assert!(speak(&request).is_ok());
    request.text.push('界');
    assert_eq!(speak(&request), Err(SpeechError::MalformedRequest));
    request.text = "  \n".into();
    assert_eq!(speak(&request), Err(SpeechError::MalformedRequest));
    for id in [
        "",
        "00000000-0000-0000-0000-00000000000A",
        "../../arbitrary-path",
        "000000000000000000000000000000000000",
    ] {
        assert_eq!(identity(id), Err(SpeechError::MalformedRequest));
    }
    let snapshot = SpeechSnapshot {
        version: 1,
        revision: u64::MAX.to_string(),
        operation_id: Some(ID.into()),
        state: SpeechState::Speaking,
        error: None,
    };
    let encoded = serde_json::to_value(snapshot).unwrap();
    assert_eq!(encoded["revision"], json!("18446744073709551615"));
    assert_eq!(encoded["state"], json!("speaking"));
}
