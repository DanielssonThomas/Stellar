use super::presentation::{IvyComponent, IvyPresentation};
use serde::Deserialize;
const MAX_TEXT: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresentationError {
    Oversized,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    stellar_presentation: Message,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    component: IvyComponent,
    title: String,
    body: String,
}

fn bounded(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum
}

/// Parse a canonical completion's plain text. Text is never a Stage-open command.
/// Consumers must display Text literally and render only the fixed component enum.
/// Invalid envelopes remain literal text; oversized completions are rejected.
pub fn parse_presentation(text: &str) -> Result<Vec<IvyPresentation>, PresentationError> {
    if text.len() > MAX_TEXT {
        return Err(PresentationError::Oversized);
    }
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    let ordinary = || {
        vec![IvyPresentation::Text {
            text: text.to_owned(),
        }]
    };
    let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
        return Ok(ordinary());
    };
    let message = envelope.stellar_presentation;
    if !bounded(&message.title, 160)
        || !bounded(&message.body, 8192)
        || !bounded(&envelope.text, MAX_TEXT)
    {
        return Ok(ordinary());
    }
    Ok(vec![
        IvyPresentation::Text {
            text: envelope.text,
        },
        IvyPresentation::Component {
            component: message.component,
            title: message.title,
            body: message.body,
        },
    ])
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
                Ok(vec![IvyPresentation::Text { text: raw.into() }])
            );
        }
    }

    #[test]
    fn known_bounded_envelope_is_accepted() {
        let raw = serde_json::json!({
            "stellar_presentation": {
                "component": "assistant_message", "title": "å".repeat(80),
                "body": "b".repeat(8192)
            },
            "text": "ordinary reply"
        })
        .to_string();
        let parsed = parse_presentation(&raw).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            parsed[0],
            IvyPresentation::Text {
                text: "ordinary reply".into()
            }
        );
        assert!(matches!(&parsed[1], IvyPresentation::Component {
            component: IvyComponent::AssistantMessage, title, body
        } if title.len() == 160 && body.len() == 8192));
    }

    #[test]
    fn oversized_completion_fails_and_oversized_component_stays_text() {
        assert_eq!(
            parse_presentation(&"å".repeat(8193)),
            Err(PresentationError::Oversized)
        );
        for (title, body) in [
            ("t".repeat(161), "b".into()),
            ("T".into(), "b".repeat(8193)),
        ] {
            let raw = serde_json::json!({
                "stellar_presentation": {"component":"assistant_message", "title":title, "body":body},
                "text":"reply"
            }).to_string();
            assert_eq!(
                parse_presentation(&raw),
                Ok(vec![IvyPresentation::Text { text: raw }])
            );
        }
    }
}
