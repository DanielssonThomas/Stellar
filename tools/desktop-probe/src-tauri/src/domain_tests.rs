use super::evaluate;
use crate::contracts::{CaptureState, ProbeError, ProbeEvent, ProbeReply, ProbeRequest};
use serde_json::{Value, json};

fn request(state: CaptureState) -> ProbeRequest {
    ProbeRequest {
        version: 1,
        sequence: "0".to_owned(),
        device_label: None,
        state,
    }
}

#[test]
fn upper_u64_sequence_roundtrips_as_a_json_string() {
    let input = ProbeRequest {
        sequence: u64::MAX.to_string(),
        device_label: Some("Windows microphone".to_owned()),
        ..request(CaptureState::Active { rms: 0.5 })
    };
    let wire = serde_json::to_value(&input).unwrap();
    assert_eq!(wire["sequence"], json!("18446744073709551615"));
    let decoded: ProbeRequest = serde_json::from_value(wire).unwrap();
    assert_eq!(decoded, input);
    let reply = evaluate(decoded).unwrap();
    assert_eq!(reply.version, input.version);
    assert_eq!(reply.sequence, input.sequence);
    assert_eq!(reply.device_label, input.device_label);
    assert_eq!(reply.state, input.state);
    assert!(reply.sound_active);
    let wire = serde_json::to_value(&reply).unwrap();
    assert_eq!(wire["sequence"], json!("18446744073709551615"));
    assert_eq!(serde_json::from_value::<ProbeReply>(wire).unwrap(), reply);
}

#[test]
fn rejects_overflow_and_noncanonical_sequences() {
    for sequence in [
        "18446744073709551616",
        "",
        "00",
        "01",
        "+1",
        "-1",
        "-0",
        " 1",
        "1 ",
        "1.0",
        "1e0",
        "one",
    ] {
        let input = ProbeRequest {
            sequence: sequence.to_owned(),
            ..request(CaptureState::Idle {})
        };
        assert_eq!(
            evaluate(input),
            Err(ProbeError::InvalidSequence {}),
            "{sequence:?}"
        );
    }
}

#[test]
fn rejects_unsupported_versions() {
    for version in [0, 2, u16::MAX] {
        let input = ProbeRequest {
            version,
            ..request(CaptureState::Idle {})
        };
        assert_eq!(
            evaluate(input),
            Err(ProbeError::UnsupportedVersion { received: version })
        );
    }
}

#[test]
fn rejects_negative_nonfinite_and_out_of_range_levels() {
    for rms in [
        -0.001,
        -1.0,
        1.000_001,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        assert_eq!(
            evaluate(request(CaptureState::Active { rms })),
            Err(ProbeError::InvalidLevel {}),
            "{rms:?}"
        );
    }
}

#[test]
fn sound_activity_obeys_threshold_and_endpoints() {
    assert!(
        !evaluate(request(CaptureState::Idle {}))
            .unwrap()
            .sound_active
    );
    for (rms, expected) in [
        (0.0, false),
        (-0.0, false),
        (0.034_999, false),
        (0.035, true),
        (0.035_001, true),
        (1.0, true),
    ] {
        let reply = evaluate(request(CaptureState::Active { rms })).unwrap();
        assert_eq!(reply.sound_active, expected, "{rms}");
        assert_eq!(reply.state, CaptureState::Active { rms });
    }
}

#[test]
fn label_limit_counts_utf8_bytes() {
    for label in [String::new(), "a".repeat(80), "é".repeat(40)] {
        let input = ProbeRequest {
            device_label: Some(label.clone()),
            ..request(CaptureState::Idle {})
        };
        assert_eq!(evaluate(input).unwrap().device_label, Some(label));
    }
    for label in [
        "a".repeat(81),
        format!("{}a", "é".repeat(40)),
        "é".repeat(41),
    ] {
        let input = ProbeRequest {
            device_label: Some(label),
            ..request(CaptureState::Idle {})
        };
        assert_eq!(evaluate(input), Err(ProbeError::LabelTooLong {}));
    }
}

#[test]
fn optional_label_accepts_omission_and_null_and_serializes_omitted() {
    for label in [None, Some(Value::Null)] {
        let mut wire = json!({"version": 1, "sequence": "0", "state": {"kind": "idle"}});
        if let Some(value) = label {
            wire["device_label"] = value;
        }
        let input: ProbeRequest = serde_json::from_value(wire).unwrap();
        assert_eq!(input.device_label, None);
        assert!(
            serde_json::to_value(&input)
                .unwrap()
                .get("device_label")
                .is_none()
        );
        let reply = evaluate(input).unwrap();
        let mut wire = serde_json::to_value(&reply).unwrap();
        assert!(wire.get("device_label").is_none());
        assert_eq!(
            serde_json::from_value::<ProbeReply>(wire.clone()).unwrap(),
            reply
        );
        wire["device_label"] = Value::Null;
        assert_eq!(serde_json::from_value::<ProbeReply>(wire).unwrap(), reply);
    }
}

#[test]
fn enum_and_error_tags_have_exact_json_shapes() {
    for (state, wire) in [
        (CaptureState::Idle {}, json!({"kind": "idle"})),
        (
            CaptureState::Active { rms: 0.25 },
            json!({"kind": "active", "rms": 0.25}),
        ),
    ] {
        assert_eq!(serde_json::to_value(&state).unwrap(), wire);
        assert_eq!(serde_json::from_value::<CaptureState>(wire).unwrap(), state);
    }
    for (error, wire) in [
        (
            ProbeError::UnsupportedVersion { received: 2 },
            json!({"code": "unsupported_version", "received": 2}),
        ),
        (
            ProbeError::InvalidSequence {},
            json!({"code": "invalid_sequence"}),
        ),
        (
            ProbeError::InvalidLevel {},
            json!({"code": "invalid_level"}),
        ),
        (
            ProbeError::LabelTooLong {},
            json!({"code": "label_too_long"}),
        ),
        (
            ProbeError::EventUnavailable {},
            json!({"code": "event_unavailable"}),
        ),
    ] {
        assert_eq!(serde_json::to_value(&error).unwrap(), wire);
        assert_eq!(serde_json::from_value::<ProbeError>(wire).unwrap(), error);
    }
}

#[test]
fn rejects_unknown_variants_fields_and_invalid_shapes() {
    for wire in [
        json!({"kind": "speech"}),
        json!({"kind": "idle", "extra": true}),
        json!({"kind": "active", "rms": 0.2, "extra": true}),
        json!({"kind": "active"}),
        json!({"kind": "active", "rms": null}),
    ] {
        assert!(serde_json::from_value::<CaptureState>(wire).is_err());
    }
    for wire in [
        json!({"code": "unknown"}),
        json!({"code": "invalid_level", "extra": true}),
        json!({"code": "unsupported_version", "received": 2, "extra": true}),
        json!({"code": "unsupported_version"}),
    ] {
        assert!(serde_json::from_value::<ProbeError>(wire).is_err());
    }
    let input = request(CaptureState::Idle {});
    let mut wire = serde_json::to_value(&input).unwrap();
    wire["extra"] = json!(true);
    assert!(serde_json::from_value::<ProbeRequest>(wire).is_err());
    let mut wire = serde_json::to_value(&input).unwrap();
    wire["sequence"] = json!(42);
    assert!(serde_json::from_value::<ProbeRequest>(wire).is_err());
    let reply = evaluate(input).unwrap();
    let mut wire = serde_json::to_value(&reply).unwrap();
    wire["extra"] = json!(true);
    assert!(serde_json::from_value::<ProbeReply>(wire).is_err());
    let event = ProbeEvent { version: 1, reply };
    let mut wire = serde_json::to_value(&event).unwrap();
    wire["extra"] = json!(true);
    assert!(serde_json::from_value::<ProbeEvent>(wire).is_err());
}

#[test]
fn event_roundtrips_with_nested_reply() {
    let event = ProbeEvent {
        version: 1,
        reply: evaluate(request(CaptureState::Idle {})).unwrap(),
    };
    let wire = serde_json::to_value(&event).unwrap();
    assert_eq!(
        wire,
        json!({
            "version": 1,
            "reply": {
                "version": 1,
                "sequence": "0",
                "state": {"kind": "idle"},
                "sound_active": false
            }
        })
    );
    assert_eq!(serde_json::from_value::<ProbeEvent>(wire).unwrap(), event);
}
