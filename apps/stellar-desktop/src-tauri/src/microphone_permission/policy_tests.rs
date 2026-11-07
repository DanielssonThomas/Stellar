use super::*;
use std::cell::Cell;

#[test]
fn only_main_owned_origin_and_version_are_admitted() {
    let url = tauri::Url::parse(OWNED_ORIGIN).unwrap();
    assert_eq!(
        validate("main", &url, None),
        Err(MicrophoneReviewError::Malformed)
    );
    assert!(validate("main", &url, Some(serde_json::json!({"version":1}))).is_ok());
    for origin in [
        "https://tauri.localhost",
        "http://tauri.localhost:81",
        "http://tauri.localhost.evil",
        "http://localhost",
        "http://user@tauri.localhost",
    ] {
        assert_eq!(
            validate(
                "main",
                &tauri::Url::parse(origin).unwrap(),
                Some(serde_json::json!({"version":1}))
            ),
            Err(MicrophoneReviewError::Forbidden)
        );
    }
    assert_eq!(
        validate(
            "workspace-browser-a",
            &url,
            Some(serde_json::json!({"version":1}))
        ),
        Err(MicrophoneReviewError::Forbidden)
    );
    assert_eq!(
        validate("main", &url, Some(serde_json::json!({"version":2}))),
        Err(MicrophoneReviewError::UnsupportedVersion)
    );
    for value in [
        serde_json::json!({"version":1,"origin":"http://tauri.localhost"}),
        serde_json::json!({"version":1,"kind":"camera"}),
        serde_json::json!({"version":1,"allow":true}),
        serde_json::json!({"version":1.5}),
        serde_json::json!({}),
    ] {
        assert_eq!(
            validate("main", &url, Some(value)),
            Err(MicrophoneReviewError::Malformed)
        );
    }
}

#[test]
fn cancelled_unsupported_and_expired_reviews_cannot_authorize_a_write() {
    let called = Cell::new(false);
    assert_eq!(
        consent(
            false,
            || true,
            || {
                called.set(true);
                Ok(true)
            }
        ),
        Err(MicrophoneReviewError::Unsupported)
    );
    assert!(!called.get());
    assert_eq!(
        consent(true, || true, || Ok(false)),
        Ok(MicrophoneReviewOutcome::Cancelled)
    );
    let current = Cell::new(true);
    assert_eq!(
        consent(
            true,
            || current.get(),
            || {
                current.set(false);
                Ok(true)
            }
        ),
        Ok(MicrophoneReviewOutcome::Cancelled)
    );
    assert_eq!(
        consent(true, || true, || Ok(true)),
        Ok(MicrophoneReviewOutcome::Allowed)
    );
}

#[test]
fn review_ownership_serializes_and_fences_drop_and_shutdown() {
    let host = ReviewHost::default();
    let lease = host.begin().unwrap();
    let token = lease.token();
    assert!(token.current());
    assert!(matches!(host.begin(), Err(MicrophoneReviewError::Busy)));
    drop(lease);
    assert!(!token.current());
    assert!(matches!(host.begin(), Err(MicrophoneReviewError::Busy)));
    drop(token);
    let next = host.begin().unwrap();
    host.shutdown();
    assert!(!next.token().current());
    assert!(matches!(
        host.begin(),
        Err(MicrophoneReviewError::Unavailable)
    ));
}

#[test]
fn serialized_review_contract_distinguishes_saved_choice_from_cancellation() {
    use crate::microphone_permission::contracts::MicrophoneReviewReply;
    for (outcome, name) in [
        (MicrophoneReviewOutcome::Allowed, "allowed"),
        (MicrophoneReviewOutcome::Cancelled, "cancelled"),
    ] {
        assert_eq!(
            serde_json::to_value(MicrophoneReviewReply {
                version: 1,
                outcome
            })
            .unwrap(),
            serde_json::json!({"version":1,"outcome":name})
        );
    }
    assert_eq!(
        serde_json::to_value(MicrophoneReviewError::UnsupportedVersion).unwrap(),
        serde_json::json!("unsupported_version")
    );
}
