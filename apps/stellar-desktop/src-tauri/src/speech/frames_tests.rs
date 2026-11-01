use super::*;
use serde_json::json;

fn run(mode: &str, values: Vec<Value>) -> Result<String, SpeechError> {
    let (sender, frames) = std::sync::mpsc::channel();
    for value in values {
        sender.send(Ok(value)).unwrap();
    }
    drop(sender);
    collect(
        &AtomicBool::new(false),
        mode,
        frames,
        Instant::now() + Duration::from_millis(30),
        || Ok(()),
    )
}

#[test]
fn only_ordered_bounded_completion_is_accepted() {
    assert_eq!(
        run(
            "transcribe",
            vec![json!({"state":"transcribing"}), json!({"text":""})]
        )
        .unwrap(),
        ""
    );
    assert_eq!(
        run(
            "speak",
            vec![
                json!({"state":"synthesizing"}),
                json!({"state":"speaking"}),
                json!({"done":true})
            ]
        )
        .unwrap(),
        ""
    );
    for values in [
        vec![json!({"text":"early"})],
        vec![
            json!({"state":"transcribing"}),
            json!({"text":"x".repeat(8193)}),
        ],
        vec![
            json!({"state":"transcribing"}),
            json!({"text":"ok","debug":"private"}),
        ],
        vec![
            json!({"state":"transcribing"}),
            json!({"state":"transcribing"}),
        ],
        vec![json!({"error":"raw provider details"})],
    ] {
        assert!(matches!(
            run("transcribe", values),
            Err(SpeechError::Protocol)
        ));
    }
    assert!(matches!(
        run(
            "speak",
            vec![json!({"state":"synthesizing"}), json!({"done":true})]
        ),
        Err(SpeechError::Protocol)
    ));
}

#[test]
fn deadline_and_cancel_do_not_accept_late_transcripts() {
    let (_sender, frames) = std::sync::mpsc::channel();
    assert!(matches!(
        collect(
            &AtomicBool::new(false),
            "transcribe",
            frames,
            Instant::now(),
            || Ok(())
        ),
        Err(SpeechError::Timeout)
    ));
    let (sender, frames) = std::sync::mpsc::channel();
    sender.send(Ok(json!({"text":"late"}))).unwrap();
    assert!(matches!(
        collect(
            &AtomicBool::new(true),
            "transcribe",
            frames,
            Instant::now() + Duration::from_secs(1),
            || Ok(())
        ),
        Err(SpeechError::Cancelled)
    ));
}
