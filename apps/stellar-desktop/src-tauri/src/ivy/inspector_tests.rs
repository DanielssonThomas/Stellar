use super::*;

fn reply() -> IvyInspectorSnapshot {
    serde_json::from_value(json!({
        "version":1,"observed_at":"2026-11-06T20:00:00Z","active_session_id":"local-current",
        "selected_session_id":"local-current","active_stored_session_id":"local-current","history_available":true,
        "sessions":[{"id":"local-current","title":"Current","model":"gpt-6.1-terra",
            "started_at":null,"last_activity_at":null,"message_count":2}],
        "next_offset":null,"messages":[{"id":1,"role":"user","text":"Hello","at":null}],
        "next_before":null,"context":{"observed_at":null,"used":12,"limit":100,"compactions":0},
        "account":{"state":"available","observed_at":null,"windows":[{
            "label":"Session","used_percent":25.0,"reset_at":null,"scope":"account"}]}
    }))
    .unwrap()
}

#[test]
fn validates_request_before_gateway_or_database_access() {
    let mut request = IvyInspectorRequest {
        version: 1,
        session_id: None,
        offset: 0,
        before_message: None,
    };
    assert!(validate_request(&request).is_ok());
    request.version = 2;
    assert!(validate_request(&request).is_err());
    request.version = 1;
    request.session_id = Some("bad\0session".into());
    assert!(validate_request(&request).is_err());
    request.session_id = None;
    request.offset = 1961;
    assert!(validate_request(&request).is_err());
    request.offset = 0;
    request.before_message = Some(0);
    assert!(validate_request(&request).is_err());
}

#[test]
fn rejects_oversized_or_uncorrelated_history_and_invalid_quota() {
    let mut snapshot = reply();
    assert!(validate_reply(&snapshot).is_ok());
    snapshot.selected_session_id = Some("other".into());
    assert!(validate_reply(&snapshot).is_err());
    snapshot = reply();
    snapshot.messages[0].text = "x".repeat(2001);
    assert!(validate_reply(&snapshot).is_err());
    snapshot = reply();
    snapshot.account.windows[0].used_percent = Some(f64::NAN);
    assert!(validate_reply(&snapshot).is_err());
    snapshot = reply();
    snapshot.context.used = Some(101);
    assert!(validate_reply(&snapshot).is_err());
}

#[test]
fn unavailable_sources_have_no_fabricated_context_or_allowance() {
    let mut snapshot = reply();
    snapshot.context = IvySessionContext {
        observed_at: None,
        used: None,
        limit: None,
        compactions: None,
    };
    snapshot.account = IvyAccountUsage {
        state: IvyUsageState::Unavailable,
        observed_at: None,
        windows: vec![],
    };
    assert!(validate_reply(&snapshot).is_ok());
    let wire = serde_json::to_value(snapshot).unwrap();
    assert!(wire["context"]["used"].is_null());
    assert!(wire["account"]["windows"].as_array().unwrap().is_empty());
}
