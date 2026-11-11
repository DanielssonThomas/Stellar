use super::{contracts::*, session::Session};
use sha2::{Digest, Sha256};

pub(super) const MAX_COMMENTARY: usize = 16;
pub(super) const MAX_COMMENTARY_BYTES: usize = 4096;

fn sealed_prose_line(line: &str) -> bool {
    let line = line.trim_start();
    if let Some(link) = line.strip_prefix('[') {
        return link.split_once("](").is_some_and(|(label, destination)| {
            !label.trim().is_empty()
                && !label.contains(['[', ']', '{', '}', '"'])
                && destination.contains(')')
        });
    }
    if let Some(link) = line.strip_prefix('<') {
        return link.split_once('>').is_some_and(|(url, _)| {
            ["https://", "http://", "mailto:"].iter().any(|prefix| {
                url.strip_prefix(prefix)
                    .is_some_and(|tail| !tail.is_empty())
            }) && !url.chars().any(char::is_whitespace)
                && !url.contains(['<', '"', '`'])
        });
    }
    if let Some(inline) = line.strip_prefix('`') {
        return inline.split_once('`').is_some_and(|(code, _)| {
            let code = code.trim_start();
            !code.is_empty() && !code.starts_with(['{', '[', '<'])
        });
    }
    !line.starts_with('{')
}

pub(super) fn plain_response(text: &str) -> bool {
    let text = text.trim();
    let lower = text.to_ascii_lowercase();
    !text.is_empty()
        && text.lines().all(sealed_prose_line)
        && ![
            "stellar_presentation",
            "<think",
            "<analysis",
            "<tool_call",
            "</think",
            "</analysis",
            "</tool_call",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
        && !text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
}

pub(super) fn segment(
    session: &str,
    admission: &str,
    generation: u64,
    event: Option<(&str, u64)>,
    text: &str,
    reused: bool,
) -> Option<IvyResponseSegment> {
    if !plain_response(text) || (event.is_some() && text.len() > MAX_COMMENTARY_BYTES) {
        return None;
    }
    let key = serde_json::to_vec(&(session, admission, generation, event)).ok()?;
    Some(IvyResponseSegment {
        id: format!("{:x}", Sha256::digest(key)),
        kind: if event.is_some() {
            IvyResponseSegmentKind::Commentary
        } else {
            IvyResponseSegmentKind::Final
        },
        text: text.trim().to_owned(),
        sequence: event.map(|(_, seq)| seq.to_string()),
        reused,
    })
}

pub(super) fn append(rows: &mut Vec<IvyResponseSegment>, segment: IvyResponseSegment) {
    if rows.iter().any(|row| row.id == segment.id) {
        return;
    }
    if matches!(segment.kind, IvyResponseSegmentKind::Commentary) && rows.len() >= MAX_COMMENTARY {
        rows.remove(0);
    }
    rows.push(segment);
}

impl Session {
    pub(super) fn complete_with_reuse(
        &mut self,
        outcome: &str,
        text: &str,
        reused: bool,
    ) -> Result<(), IvyErrorCode> {
        let turn = match outcome {
            "completed" => IvyTurnState::Completed,
            "failed" => IvyTurnState::Failed,
            "cancelled" | "interrupted" => IvyTurnState::Cancelled,
            _ => return Err(IvyErrorCode::Uncertain),
        };
        let failed = turn == IvyTurnState::Failed;
        let items = if failed {
            vec![]
        } else {
            super::presentation_decode::parse_presentation(text)
        };
        let response = items
            .iter()
            .filter_map(|item| match item {
                super::presentation::IvyPresentation::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let final_segment = if turn == IvyTurnState::Completed {
            super::response_segments::segment(
                self.record.session_id.as_deref().unwrap_or_default(),
                self.record.admission_id.as_deref().unwrap_or_default(),
                self.record.generation.unwrap_or_default(),
                None,
                &response,
                reused,
            )
        } else {
            None
        };
        self.record.unsettled = false;
        self.journal.save(&self.record)?;
        self.shared.update(self.epoch, |view| {
            if let Some(row) = final_segment {
                super::response_segments::append(&mut view.response_segments, row);
            }
            view.activity.clear();
            view.turn = turn;
            view.questions = None;
            view.turn_id = self.record.input_id.clone();
            view.items = items;
            view.error = if failed {
                Some(IvyErrorCode::TurnFailed)
            } else {
                None
            };
        });
        Ok(())
    }
}
