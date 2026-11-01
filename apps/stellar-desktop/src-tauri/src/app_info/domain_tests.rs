use super::super::contracts::{AppCapability, AppInfoError, AppInfoReply, AppInfoRequest};
use super::app_info;
use serde_json::{Value, json};

fn request(sequence: &str, label: Option<String>) -> AppInfoRequest {
    AppInfoRequest {
        version: 1,
        sequence: sequence.to_owned(),
        label,
    }
}

fn reply_fixture() -> Value {
    serde_json::from_str::<Value>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../libs/desktop-contracts/fixtures/app-info.json"
    )))
    .unwrap()["reply"]
        .clone()
}

#[test]
fn upper_u64_round_trips_as_a_decimal_string() {
    let sequence = u64::MAX.to_string();
    let input = request(&sequence, None);
    let encoded_request = serde_json::to_value(&input).unwrap();
    assert_eq!(encoded_request["sequence"], json!(sequence));
    let decoded = serde_json::from_value::<AppInfoRequest>(encoded_request).unwrap();
    let reply = app_info(decoded).unwrap();
    assert_eq!(reply.sequence, sequence);
    assert_eq!(reply.version, 1);
    assert_eq!(reply.application, "stellar-desktop");
    assert_eq!(
        reply.capabilities,
        vec![
            AppCapability::NativeWindow {},
            AppCapability::ContractEvents {},
        ]
    );
    assert_eq!(reply.build_revision, None);
    let encoded_reply = serde_json::to_value(&reply).unwrap();
    assert_eq!(encoded_reply, reply_fixture());
    assert_eq!(
        serde_json::from_value::<AppInfoReply>(encoded_reply).unwrap(),
        reply
    );
}

#[test]
fn canonical_zero_and_other_valid_sequences_are_accepted() {
    for sequence in ["0", "1", "42", "9007199254740993"] {
        assert_eq!(
            app_info(request(sequence, None)).unwrap().sequence,
            sequence
        );
    }
}

#[test]
fn noncanonical_and_out_of_range_sequences_are_rejected() {
    for sequence in [
        "",
        "+1",
        "-1",
        "-0",
        "00",
        "01",
        " 1",
        "1 ",
        "1\n",
        "1.0",
        "1e3",
        "0x10",
        "1_000",
        "１２",
        "18446744073709551616",
    ] {
        assert_eq!(
            app_info(request(sequence, None)),
            Err(AppInfoError::InvalidSequence {}),
            "sequence: {sequence:?}"
        );
    }
}

#[test]
fn only_version_one_is_supported() {
    for version in [0, 2, u16::MAX] {
        let mut input = request("0", None);
        input.version = version;
        assert_eq!(
            app_info(input),
            Err(AppInfoError::UnsupportedVersion { received: version })
        );
    }
}

#[test]
fn labels_are_preserved_and_limited_by_utf8_bytes() {
    for label in [
        String::new(),
        "a".repeat(80),
        "é".repeat(40),
        "🦀".repeat(20),
    ] {
        let reply = app_info(request("0", Some(label.clone()))).unwrap();
        assert_eq!(reply.label, Some(label.clone()));
        assert_eq!(serde_json::to_value(reply).unwrap()["label"], json!(label));
    }
    for label in [
        "a".repeat(81),
        format!("{}a", "é".repeat(40)),
        "🦀".repeat(21),
    ] {
        assert_eq!(
            app_info(request("0", Some(label))),
            Err(AppInfoError::LabelTooLong {})
        );
    }
}

#[path = "wire_tests.rs"]
mod wire_tests;
