use super::presentation::{IvyComponent, IvyPresentation};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    stellar_presentation: Presentation,
    text: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Presentation {
    Message(Message),
    Close(CloseActivity),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseActivity {
    action: CloseAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CloseAction {
    CloseActivity,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    component: IvyComponent,
    title: String,
    body: String,
}

/// Parse a canonical completion's plain text. Text is never a Stage-open command.
/// Consumers must display Text literally and render only the fixed component enum.
/// Invalid envelopes remain literal text. Content has no application byte ceiling.
pub fn parse_presentation(text: &str) -> Vec<IvyPresentation> {
    if text.trim().is_empty() {
        return vec![];
    }
    let ordinary = || {
        vec![IvyPresentation::Text {
            text: text.to_owned(),
        }]
    };
    let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
        return ordinary();
    };
    if envelope.text.trim().is_empty() {
        return ordinary();
    }
    let presentation = match envelope.stellar_presentation {
        Presentation::Message(message) => {
            if message.title.trim().is_empty() || message.body.trim().is_empty() {
                return ordinary();
            }
            IvyPresentation::Component {
                component: message.component,
                title: message.title,
                body: message.body,
            }
        }
        Presentation::Close(CloseActivity {
            action: CloseAction::CloseActivity,
        }) => IvyPresentation::CloseActivity,
    };
    vec![
        IvyPresentation::Text {
            text: envelope.text,
        },
        presentation,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_component_and_raw_html_remain_literal_text() {
        for raw in [
            "<script>alert('not executable')</script>",
            r#"{"stellar_presentation":{"component":"web_view","title":"T","body":"B"},"text":"reply"}"#,
            r#"{"stellar_presentation":{"component":"assistant_message","title":"T","body":"B","extra":true},"text":"reply"}"#,
            r#"{"stellar_presentation":{"component":"assistant_message","title":"T","body":"B"},"text":"reply","extra":true}"#,
            r#"{"stellar_presentation":{"component":"assistant_message","title":"T","title":"duplicate","body":"B"},"text":"reply"}"#,
        ] {
            assert_eq!(
                parse_presentation(raw),
                vec![IvyPresentation::Text { text: raw.into() }]
            );
        }
    }

    #[test]
    fn complete_long_unicode_envelope_is_preserved() {
        let raw = serde_json::json!({
            "stellar_presentation": {
                "component": "assistant_message", "title": "å".repeat(1000),
                "body": "🪐\\\"\n".repeat(100_000)
            },
            "text": "ordinary reply"
        })
        .to_string();
        let parsed = parse_presentation(&raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            parsed[0],
            IvyPresentation::Text {
                text: "ordinary reply".into()
            }
        );
        assert!(matches!(&parsed[1], IvyPresentation::Component {
            component: IvyComponent::AssistantMessage, title, body
        } if title == &"å".repeat(1000) && body == &"🪐\\\"\n".repeat(100_000)));
    }

    #[test]
    fn long_ordinary_text_and_explicit_close_are_supported() {
        let text = "å".repeat(100_000);
        assert_eq!(
            parse_presentation(&text),
            vec![IvyPresentation::Text { text }]
        );
        assert_eq!(
            parse_presentation(
                r#"{"text":"Closed","stellar_presentation":{"action":"close_activity"}}"#
            ),
            vec![
                IvyPresentation::Text {
                    text: "Closed".into()
                },
                IvyPresentation::CloseActivity
            ]
        );
        for raw in [
            r#"{"text":"Closed","stellar_presentation":{"action":"close_all"}}"#,
            r#"{"text":"Closed","stellar_presentation":{"action":"close_activity","extra":true}}"#,
            r#"{"text":"Closed","stellar_presentation":{"action":"close_activity","action":"close_activity"}}"#,
        ] {
            assert_eq!(
                parse_presentation(raw),
                vec![IvyPresentation::Text { text: raw.into() }]
            );
        }
    }
}
