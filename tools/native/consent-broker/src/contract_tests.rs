use crate::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) fn scope(challenge: usize, binding: usize) -> Prepared {
    use std::time::{SystemTime, UNIX_EPOCH};
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    Prepared {
        version: 1,
        challenge_id: format!("{challenge:064x}"),
        connection_binding: format!("{binding:064x}"),
        origin: Origin {
            profile_id: "ivy".into(),
            session_id: "logical-1".into(),
            physical_target: "physical-1".into(),
            route: "acp".into(),
            producer_id: "stellar-herdr".into(),
            worker_incarnation: "a".repeat(32),
        },
        display_scope: DisplayScope {
            profile_label: "Ivy".into(),
            conversation_label: "Original conversation".into(),
            producer_label: "Stellar".into(),
            effects: vec!["render".into(), "speech".into()],
        },
        expires_at: wall + 120_000,
        max_admissions: 3,
        challenge_expires_at: wall + 60_000,
    }
}

#[test]
fn requests_are_closed_and_proof_free() {
    for method in ["completeConsent", "cancelConsent"] {
        let frame = format!(
            r#"{{"method":"{method}","params":{{"challengeId":"{}"}}}}"#,
            "a".repeat(64)
        );
        assert!(decode_request(frame.as_bytes()).is_ok());
    }
    assert!(
        decode_request(br#"{"method":"prepareConsent","params":{"session_id":"original"}}"#)
            .is_ok()
    );
    for frame in [
        r#"{"method":"prepareConsent","params":{"session_id":"s","session_id":"s"}}"#,
        r#"{"method":"prepareConsent","params":{"session_id":"s"},"actor":"native"}"#,
        r#"{"method":"prepareConsent","method":"prepareConsent","params":{"session_id":"s"}}"#,
        r#"{"method":"prepareConsent","params":{"session_id":"s","transportId":"t"}}"#,
        r#"{"method":"prepareConsent","params":{"session_id":"s s"}}"#,
        r#"{"method":"prepareConsent","params":{"session_id":"\ud800"}}"#,
        r#"{"method":"prepareConsent","params":{"session_id":1}}"#,
        r#"{"method":"approve","params":{}}"#,
        r#"{"method":"completeConsent","params":{"challengeId":"a","gestureProof":true}}"#,
    ] {
        assert_eq!(
            decode_request(frame.as_bytes()),
            Err(Error::InvalidRequest),
            "{frame}"
        );
    }
}

#[test]
fn frame_limits_and_non_json_refuse() {
    for bytes in [
        vec![],
        vec![b' '; 16_385],
        vec![0xff],
        b"null".to_vec(),
        b"{} {}".to_vec(),
    ] {
        assert_eq!(decode_request(&bytes), Err(Error::InvalidRequest));
    }
    let too_long = json!({"method":"prepareConsent","params":{"session_id":"x".repeat(513)}});
    assert!(decode_request(&serde_json::to_vec(&too_long).unwrap()).is_err());
}

#[test]
fn identifiers_match_all_pinned_python_unicode_scalars() {
    for value in [
        "\u{200b}", "\u{202e}", "\u{e000}", "\u{378}", "\u{a0}", "\u{2028}",
    ] {
        assert!(!crate::scope::identifier(value, 512));
    }
    assert!(crate::scope::identifier("session-\u{e5}", 512));
    let mut hash = Sha256::new();
    for point in 0..0x110000 {
        let valid =
            char::from_u32(point).is_some_and(|c| crate::scope::identifier(&c.to_string(), 512));
        hash.update([u8::from(valid)]);
    }
    let actual: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let metadata: Value = serde_json::from_str(include_str!("../data/printable-16.json")).unwrap();
    assert_eq!(actual, metadata["identifierScalarSha256"].as_str().unwrap());
}

#[test]
fn empty_dependencies_are_representable_without_empty_programs() {
    let mut value = manifest();
    value["artifacts"].as_array_mut().unwrap().push(json!({"role":"dependency",
        "path":"modules/__init__.py","length":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}));
    assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_ok());
    value["artifacts"][0]["length"] = json!(0);
    assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn prepared_response_roundtrips_without_claiming_trust() {
    let request =
        decode_request(br#"{"method":"prepareConsent","params":{"session_id":"s"}}"#).unwrap();
    let response = Response::Prepared(Box::new(scope(1, 1)));
    let wire = encode_response(&response).unwrap();
    assert_eq!(decode_response(&request, &wire).unwrap(), response);
    let mut value: Value = serde_json::from_slice(&wire).unwrap();
    for (path, bad) in [
        ("version", json!(2)),
        ("expiresAt", json!(9_007_199_254_740_992_u64)),
        ("expiresAt", json!(1.0)),
        ("maxAdmissions", json!(0)),
        ("maxAdmissions", json!(101)),
        ("challengeId", json!("A".repeat(64))),
    ] {
        let previous = value[path].clone();
        value[path] = bad;
        assert!(decode_response(&request, &serde_json::to_vec(&value).unwrap()).is_err());
        value[path] = previous;
    }
    value["origin"]["actor"] = json!("native");
    assert!(decode_response(&request, &serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn nested_duplicates_labels_and_effects_refuse() {
    let mut prepared = scope(1, 1);
    prepared.display_scope.effects = vec!["render".into()];
    assert_eq!(prepared.validate(), Err(Error::InvalidRequest));
    prepared = scope(1, 1);
    prepared.display_scope.profile_label = "x".repeat(257);
    assert!(prepared.validate().is_err());
    prepared.display_scope.profile_label = "Ivy\nAdmin".into();
    assert!(prepared.validate().is_err());
    let text = String::from_utf8(serde_json::to_vec(&scope(1, 1)).unwrap()).unwrap();
    let duplicated = text.replace(
        "\"profileId\":\"ivy\"",
        "\"profileId\":\"ivy\",\"profileId\":\"ivy\"",
    );
    let request =
        decode_request(br#"{"method":"prepareConsent","params":{"session_id":"s"}}"#).unwrap();
    assert!(decode_response(&request, duplicated.as_bytes()).is_err());
}

#[test]
fn ticket_cancel_and_error_have_exact_closed_shapes() {
    let complete = decode_request(
        format!(
            r#"{{"method":"completeConsent","params":{{"challengeId":"{}"}}}}"#,
            "a".repeat(64)
        )
        .as_bytes(),
    )
    .unwrap();
    assert!(
        decode_response(
            &complete,
            format!(r#"{{"consentTicket":"{}"}}"#, "b".repeat(64)).as_bytes()
        )
        .is_ok()
    );
    for bytes in [
        br#"{"consentTicket":"x"}"#.as_slice(),
        br#"{"cancelled":true}"#,
        br#"{"consentTicket":"x","verified":true}"#,
    ] {
        assert!(decode_response(&complete, bytes).is_err());
    }
    let cancel = decode_request(
        format!(
            r#"{{"method":"cancelConsent","params":{{"challengeId":"{}"}}}}"#,
            "a".repeat(64)
        )
        .as_bytes(),
    )
    .unwrap();
    assert!(decode_response(&cancel, br#"{"cancelled":true}"#).is_ok());
    assert!(decode_response(&cancel, br#"{"cancelled":false}"#).is_err());
    assert_eq!(
        decode_error(&encode_error(Error::Uncertain)).unwrap().code,
        Error::Uncertain
    );
    for bytes in [
        br#"{"code":"Uncertain","retryAuthorized":true}"#.as_slice(),
        br#"{"code":"Unknown","retryAuthorized":false}"#,
        br#"{"code":"Busy","retryAuthorized":false,"detail":"private"}"#,
        br#"{"code":"Busy","retryAuthorized":false,"retryAuthorized":false}"#,
    ] {
        assert_eq!(decode_error(bytes), Err(Error::InvalidRequest));
    }
}

pub(crate) fn manifest() -> Value {
    json!({"schemaVersion":2,"purpose":"code_set_identity_only",
        "semanticProposalSha256":crate::protocol::SEMANTICS,"contractSha256":crate::protocol::CONTRACT,
        "hostInterfaceSha256":crate::protocol::HOST_INTERFACE,"releaseId":"candidate-1",
        "threatPolicy":"cooperative-tcb-v1",
        "artifacts":(["broker","desktop","guardian","interpreter","host"].map(|role|
            json!({"role":role,"path":format!("{role}/code.bin"),"length":1,"sha256":"a".repeat(64)})))})
}

#[test]
fn manifest_validates_only_review_identity() {
    let value = manifest();
    assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_ok());
    for (field, bad) in [
        ("schemaVersion", json!(1)),
        ("purpose", json!("launch_authorization")),
        ("contractSha256", json!("b".repeat(64))),
        ("threatPolicy", json!("hostile_same_user")),
        ("releaseId", json!("")),
    ] {
        let mut changed = value.clone();
        changed[field] = bad;
        assert!(decode_manifest(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
}

#[test]
fn windows_aliases_and_path_tricks_refuse() {
    for path in [
        "",
        "/absolute",
        "C:/root",
        "../escape",
        "a/../b",
        "a//b",
        "a\\b",
        "a:stream",
        "file.",
        "file ",
        "CON",
        "nul.txt",
        "a/LPT1.exe",
        "COM9/file",
        "com¹",
        "a/~short",
        "//server/share",
        "a/./b",
        "a\0b",
        "é.bin",
    ] {
        let mut value = manifest();
        value["artifacts"][0]["path"] = json!(path);
        assert!(
            decode_manifest(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{path:?}"
        );
    }
    for path in [
        "broker/code.bin",
        "BROKER/CODE.BIN",
        "broker/code.bin/child",
    ] {
        let mut value = manifest();
        value["artifacts"][1]["path"] = json!(path);
        assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}

#[test]
fn manifest_bounds_and_duplicates_refuse() {
    for length in [0_u64, 4_294_967_297, u64::MAX] {
        let mut value = manifest();
        value["artifacts"][0]["length"] = json!(length);
        assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = manifest();
    value["artifacts"][0]["role"] = json!("host");
    assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
    let mut value = manifest();
    for item in value["artifacts"].as_array_mut().unwrap() {
        item["length"] = json!(4_294_967_296_u64);
    }
    assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
    let text = serde_json::to_string(&manifest()).unwrap().replace(
        "\"schemaVersion\":2",
        "\"schemaVersion\":2,\"schemaVersion\":2",
    );
    assert!(decode_manifest(text.as_bytes()).is_err());
    assert!(decode_manifest(&vec![b' '; 65_537]).is_err());
}

#[test]
fn operational_entry_is_unavailable() {
    assert!(matches!(Broker::unavailable(), Err(Error::HostUnverified)));
}
