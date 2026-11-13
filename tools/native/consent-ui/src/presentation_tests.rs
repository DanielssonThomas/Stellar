use super::*;

fn view() -> GrantView {
    GrantView::new(["Ivy", "Original conversation", "Worker"], 100_000, 3).unwrap()
}

#[test]
fn literal_scope_is_preserved_without_markup_or_truncation() {
    let view = GrantView::new(["Ivy", "<b>literal & scope</b>", "Worker"], 100, 1).unwrap();
    assert_eq!(view.labels(), ["Ivy", "<b>literal & scope</b>", "Worker"]);
    assert_eq!(view.effects(), ["render", "speech"]);
    assert_eq!(view.expires_at_ms(), 100);
    assert_eq!(view.max_admissions(), 1);
}

#[test]
fn ambiguous_labels_and_out_of_policy_limits_refuse() {
    for label in [
        "",
        " ",
        "line\nbreak",
        "reverse\u{202e}scope",
        "isolate\u{2066}scope",
    ] {
        assert_eq!(
            GrantView::new(["Ivy", label, "Worker"], 100, 1),
            Err(UiError::InvalidScope)
        );
    }
    for (expiry, budget) in [(0, 1), (100, 0), (100, 101), (u64::MAX, 1)] {
        assert_eq!(
            GrantView::new(["Ivy", "Session", "Worker"], expiry, budget),
            Err(UiError::InvalidScope)
        );
    }
}

#[test]
fn affirmative_is_only_one_request_and_cancellation_remains_available() {
    let mut ui = Presentation::new(view());
    assert_eq!(ui.request(Action::Affirm), Ok(UiRequest::Complete));
    assert_eq!(ui.request(Action::Affirm), Err(UiError::Closed));
    assert_eq!(ui.request(Action::Cancel), Ok(UiRequest::Cancel));
    assert_eq!(ui.request(Action::Affirm), Err(UiError::Closed));
}

#[test]
fn destruction_requests_cancellation_without_claiming_host_rollback() {
    let mut ui = Presentation::new(view());
    assert_eq!(ui.view().max_admissions(), 3);
    assert_eq!(ui.request(Action::Destroyed), Ok(UiRequest::Cancel));
    assert_eq!(ui.request(Action::Cancel), Err(UiError::Closed));
    assert!(matches!(present_native(view()), Err(UiError::Unavailable)));
}
