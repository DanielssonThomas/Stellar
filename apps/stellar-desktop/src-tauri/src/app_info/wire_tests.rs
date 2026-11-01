use super::{app_info, reply_fixture, request};
use crate::app_info::contracts::{
    APP_INFO_EVENT, AppCapability, AppInfoError, AppInfoEvent, AppInfoReply, AppInfoRequest,
};
use serde_json::{Value, json};

#[test]
fn shared_error_fixtures_match_typescript_inputs() {
    let fixtures: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../libs/desktop-contracts/fixtures/app-info.json"
    )))
    .unwrap();
    for value in fixtures["errors"].as_array().unwrap() {
        let error: AppInfoError = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(error).unwrap(), *value);
    }
}

#[test]
fn omitted_and_null_labels_normalize_to_omitted_output() {
    for input in [
        json!({"version": 1, "sequence": "0"}),
        json!({"version": 1, "sequence": "0", "label": null}),
    ] {
        let decoded = serde_json::from_value::<AppInfoRequest>(input).unwrap();
        assert_eq!(decoded.label, None);
        assert!(
            serde_json::to_value(&decoded)
                .unwrap()
                .get("label")
                .is_none()
        );
        let reply = app_info(decoded).unwrap();
        assert!(serde_json::to_value(reply).unwrap().get("label").is_none());
    }

    let mut input = reply_fixture();
    input["label"] = Value::Null;
    let reply = serde_json::from_value::<AppInfoReply>(input).unwrap();
    assert_eq!(serde_json::to_value(reply).unwrap(), reply_fixture());
}

#[test]
fn build_revision_is_required_but_nullable() {
    let fixture = reply_fixture();
    let reply = serde_json::from_value::<AppInfoReply>(fixture.clone()).unwrap();
    assert_eq!(reply.build_revision, None);
    assert_eq!(serde_json::to_value(reply).unwrap(), fixture);

    let mut missing = reply_fixture();
    missing.as_object_mut().unwrap().remove("build_revision");
    assert!(serde_json::from_value::<AppInfoReply>(missing).is_err());

    let mut embedded = reply_fixture();
    embedded["build_revision"] = json!("embedded-revision");
    let reply = serde_json::from_value::<AppInfoReply>(embedded.clone()).unwrap();
    assert_eq!(reply.build_revision.as_deref(), Some("embedded-revision"));
    assert_eq!(serde_json::to_value(reply).unwrap(), embedded);

    let mut malformed = reply_fixture();
    malformed["build_revision"] = json!(42);
    assert!(serde_json::from_value::<AppInfoReply>(malformed).is_err());
}

#[test]
fn tagged_capabilities_match_wire_fixtures() {
    for (capability, fixture) in [
        (
            AppCapability::NativeWindow {},
            json!({"kind": "native_window"}),
        ),
        (
            AppCapability::ContractEvents {},
            json!({"kind": "contract_events"}),
        ),
    ] {
        assert_eq!(serde_json::to_value(&capability).unwrap(), fixture);
        assert_eq!(
            serde_json::from_value::<AppCapability>(fixture).unwrap(),
            capability
        );
    }
}

#[cfg(feature = "contract-variant-fixture")]
#[test]
fn future_capability_is_available_for_the_negative_fixture() {
    let capability = AppCapability::FutureCapability {};
    let fixture = json!({"kind": "future_capability"});
    assert_eq!(serde_json::to_value(&capability).unwrap(), fixture);
    assert_eq!(
        serde_json::from_value::<AppCapability>(fixture).unwrap(),
        capability
    );
}

#[test]
fn tagged_errors_match_wire_fixtures_without_internal_details() {
    for (error, fixture) in [
        (
            AppInfoError::UnsupportedVersion { received: 2 },
            json!({"code": "unsupported_version", "received": 2}),
        ),
        (
            AppInfoError::InvalidSequence {},
            json!({"code": "invalid_sequence"}),
        ),
        (
            AppInfoError::LabelTooLong {},
            json!({"code": "label_too_long"}),
        ),
        (
            AppInfoError::EventUnavailable {},
            json!({"code": "event_unavailable"}),
        ),
    ] {
        assert_eq!(serde_json::to_value(&error).unwrap(), fixture);
        assert_eq!(
            serde_json::from_value::<AppInfoError>(fixture).unwrap(),
            error
        );
    }
}

#[test]
fn event_matches_the_wire_fixture() {
    assert_eq!(APP_INFO_EVENT, "app-info-observed");
    let event = AppInfoEvent {
        version: 1,
        info: app_info(request("18446744073709551615", None)).unwrap(),
    };
    let fixture = json!({"version": 1, "info": reply_fixture()});
    assert_eq!(serde_json::to_value(&event).unwrap(), fixture);
    assert_eq!(
        serde_json::from_value::<AppInfoEvent>(fixture).unwrap(),
        event
    );
}

#[test]
fn malformed_requests_and_unknown_fields_are_rejected() {
    for input in [
        json!({}),
        json!({"version": 1}),
        json!({"sequence": "0"}),
        json!({"version": 1, "sequence": 0}),
        json!({"version": 1, "sequence": null}),
        json!({"version": "1", "sequence": "0"}),
        json!({"version": -1, "sequence": "0"}),
        json!({"version": 65536, "sequence": "0"}),
        json!({"version": 1.5, "sequence": "0"}),
        json!({"version": 1, "sequence": "0", "label": 5}),
        json!({"version": 1, "sequence": "0", "extra": true}),
        json!([]),
        Value::Null,
    ] {
        assert!(
            serde_json::from_value::<AppInfoRequest>(input.clone()).is_err(),
            "input: {input}"
        );
    }
    assert!(
        serde_json::from_str::<AppInfoRequest>(r#"{"version":1,"version":1,"sequence":"0"}"#)
            .is_err()
    );
}

#[test]
fn unknown_variants_and_enum_fields_are_rejected() {
    for input in [
        json!({"kind": "unknown_capability"}),
        json!({"kind": "NativeWindow"}),
        json!({"kind": "native_window", "extra": true}),
        json!({"kind": "contract_events", "extra": true}),
        json!({}),
    ] {
        assert!(serde_json::from_value::<AppCapability>(input).is_err());
    }
    for input in [
        json!({"code": "unknown_error"}),
        json!({"code": "unsupported_version"}),
        json!({"code": "unsupported_version", "received": 2, "extra": true}),
        json!({"code": "invalid_sequence", "extra": true}),
        json!({"code": "label_too_long", "extra": true}),
        json!({"code": "event_unavailable", "message": "internal details"}),
    ] {
        assert!(serde_json::from_value::<AppInfoError>(input).is_err());
    }
}

#[test]
fn reply_and_event_reject_unknown_fields() {
    let mut reply = reply_fixture();
    reply["extra"] = json!(true);
    assert!(serde_json::from_value::<AppInfoReply>(reply.clone()).is_err());
    assert!(
        serde_json::from_value::<AppInfoEvent>(json!({
            "version": 1,
            "info": reply
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<AppInfoEvent>(json!({
            "version": 1,
            "info": reply_fixture(),
            "extra": true
        }))
        .is_err()
    );
}
