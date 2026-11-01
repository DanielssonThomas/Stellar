use super::status;
use crate::contracts::{ShellError, ShellReply, ShellRequest};

#[test]
fn version_one_returns_ready_shell() {
    assert_eq!(
        status(ShellRequest { version: 1 }),
        Ok(ShellReply {
            version: 1,
            application: String::from("stellar-desktop"),
            ready: true,
        })
    );
}

#[test]
fn mismatched_versions_are_rejected() {
    for version in [0, 2, u16::MAX] {
        assert_eq!(
            status(ShellRequest { version }),
            Err(ShellError::UnsupportedVersion { received: version })
        );
    }
}

#[test]
fn request_matches_json_fixture() {
    let fixture = r#"{"version":1}"#;
    let request = ShellRequest { version: 1 };

    assert_eq!(serde_json::to_string(&request).unwrap(), fixture);
    assert_eq!(
        serde_json::from_str::<ShellRequest>(fixture).unwrap(),
        request
    );
}

#[test]
fn reply_matches_json_fixture() {
    let fixture = r#"{"version":1,"application":"stellar-desktop","ready":true}"#;
    let reply = status(ShellRequest { version: 1 }).unwrap();

    assert_eq!(serde_json::to_string(&reply).unwrap(), fixture);
    assert_eq!(serde_json::from_str::<ShellReply>(fixture).unwrap(), reply);
}

#[test]
fn error_matches_internally_tagged_json_fixture() {
    let fixture = r#"{"code":"unsupported_version","received":2}"#;
    let error = status(ShellRequest { version: 2 }).unwrap_err();

    assert_eq!(serde_json::to_string(&error).unwrap(), fixture);
    assert_eq!(serde_json::from_str::<ShellError>(fixture).unwrap(), error);
}

#[test]
fn request_rejects_unknown_fields() {
    let fixture = r#"{"version":1,"unexpected":true}"#;

    assert!(serde_json::from_str::<ShellRequest>(fixture).is_err());
}

#[test]
fn request_rejects_invalid_versions() {
    for fixture in [
        r#"{}"#,
        r#"{"version":-1}"#,
        r#"{"version":65536}"#,
        r#"{"version":"1"}"#,
        r#"{"version":null}"#,
        r#"{"version":1.5}"#,
    ] {
        assert!(
            serde_json::from_str::<ShellRequest>(fixture).is_err(),
            "unexpectedly accepted {fixture}"
        );
    }
}
