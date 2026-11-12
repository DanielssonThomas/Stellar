use super::{contracts::*, session_tests::fixture};
use serde_json::{Value, json};

fn event(admission: &str, sequence: u64, text: &str) -> Value {
    json!({"event":"gateway","data":{"params":{
        "type":"message.interim","session_id":"session","admission_id":admission,
        "execution_generation":3,"replay_epoch":"epoch","seq":sequence,
        "payload":{"text":text,"already_streamed":false}
    }}})
}

#[test]
fn committed_segments_preserve_admission_and_deduplicate_replay_before_final() {
    let (mut session, directory) = fixture();
    session.event(event("foreign", 1, "Wrong turn")).unwrap();
    session
        .event(event(
            "admission",
            2,
            "Morning! I am checking your calendar.",
        ))
        .unwrap();
    session
        .event(event("admission", 3, "Your meeting is at ten."))
        .unwrap();
    let before = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(before.response_segments.len(), 2);
    assert!(before.items.is_empty());
    assert!(session.record.unsettled);
    session.event(event("admission", 2, "Duplicate")).unwrap();
    assert_eq!(
        session.shared.view.lock().unwrap().snapshot.revision,
        before.revision
    );
    let mut done = event("admission", 4, "Your meeting is at ten.");
    done["data"]["params"]["type"] = json!("message.complete");
    done["data"]["params"]["payload"] =
        json!({"text":"Your meeting is at ten.","outcome":"completed","response_reused":true});
    session.event(done.clone()).unwrap();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(snapshot.turn, IvyTurnState::Completed);
    assert!(!session.record.unsettled);
    assert_eq!(snapshot.response_segments.len(), 3);
    assert!(snapshot.response_segments.last().unwrap().reused);
    session.event(done).unwrap();
    assert_eq!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .response_segments
            .len(),
        3
    );
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn commentary_filters_data_bounds_history_and_fails_closed_on_epoch_changes() {
    let (mut session, directory) = fixture();
    for (index, text) in [
        "{\"partial\":",
        "```json",
        "<think>private</think>",
        "The stellar_presentation is data",
        &"x".repeat(4097),
    ]
    .iter()
    .enumerate()
    {
        session
            .event(event("admission", index as u64 + 1, text))
            .unwrap();
    }
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .response_segments
            .is_empty()
    );
    for sequence in 6..36 {
        session
            .event(event("admission", sequence, "A committed public update."))
            .unwrap();
    }
    assert_eq!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .response_segments
            .len(),
        16
    );
    let mut stale = event("admission", 36, "Wrong generation");
    stale["data"]["params"]["execution_generation"] = json!(4);
    assert!(matches!(session.event(stale), Err(IvyErrorCode::Uncertain)));
    let mut gap = event("admission", 37, "Wrong epoch");
    gap["data"]["params"]["replay_epoch"] = json!("other");
    assert!(matches!(session.event(gap), Err(IvyErrorCode::Uncertain)));
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn sealed_prose_accepts_ordinary_markdown_leads_and_rejects_structured_leads() {
    use super::response_segments::plain_response;

    for text in [
        "[The notes](https://example.test/notes) are ready.",
        "[The notes](\n  https://example.test/notes\n  \"Report title\") are ready.",
        "<https://example.test/notes> has the notes.",
        "<mailto:hello@example.test> is the contact address.",
        "\x60npm test\x60 has finished.",
    ] {
        assert!(plain_response(text), "{text}");
    }
    for text in [
        "[\"private\"]",
        "<script>private</script>",
        "\x60\x60\x60js\nprivate\n\x60\x60\x60",
        "\x60{\"private\":true}\x60",
        "<https://example.test/notes",
        "Closing </tool_call> marker",
    ] {
        assert!(!plain_response(text), "{text}");
    }
}

#[test]
fn closing_tool_marker_preserves_the_completed_answer_without_a_segment() {
    let (mut session, directory) = fixture();
    let text = "Use the closing </tool_call> tag.";
    session.event(event("admission", 1, text)).unwrap();
    let mut done = event("admission", 2, text);
    done["data"]["params"]["type"] = json!("message.complete");
    done["data"]["params"]["payload"] =
        json!({"text":text,"outcome":"completed","response_reused":false});
    session.event(done).unwrap();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    assert_eq!(snapshot.turn, IvyTurnState::Completed);
    assert!(snapshot.response_segments.is_empty());
    assert!(matches!(
        snapshot.items.as_slice(),
        [super::presentation::IvyPresentation::Text { text: reply }] if reply == text
    ));
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
