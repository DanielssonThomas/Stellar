use super::{contracts::*, host::SpeechHost, process, validation};
use serde_json::json;
use std::time::Duration;

impl SpeechHost {
    pub(super) fn keywords(&self, request: KeywordRequest) -> Result<KeywordReply, SpeechError> {
        validation::version(request.version)?;
        let epoch = validation::epoch(&request.epoch)?;
        if request.stream_id.is_empty()
            || request.stream_id.len() > 96
            || !request
                .stream_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
            || request.pcm.is_empty()
            || request.pcm.len() > 640
            || !request.threshold.is_finite()
            || !(0.001..=0.2).contains(&request.threshold)
        {
            return Err(SpeechError::MalformedRequest);
        }
        let ticket = {
            let view = self
                .inner
                .view
                .lock()
                .map_err(|_| SpeechError::Unavailable)?;
            if view.closed || epoch != view.epoch {
                return Err(SpeechError::Cancelled);
            }
            if matches!(
                view.snapshot.state,
                SpeechState::Speaking | SpeechState::Synthesizing
            ) {
                return Err(SpeechError::Busy);
            }
            self.inner.keywords.ticket()
        };
        let payload = process::payload(json!({"stream_id": request.stream_id,
            "sequence": request.sequence, "pcm": request.pcm,
            "threshold": request.threshold, "mode": request.mode}))?;
        let frame = self
            .inner
            .keywords
            .request(payload, ticket, Duration::from_secs(10))?;
        let reply = match decode_reply(frame, &request) {
            Ok(reply) => reply,
            Err(error) => {
                self.inner.keywords.stop()?;
                return Err(error);
            }
        };
        let view = self
            .inner
            .view
            .lock()
            .map_err(|_| SpeechError::Unavailable)?;
        if view.closed || epoch != view.epoch {
            return Err(SpeechError::Cancelled);
        }
        if matches!(
            view.snapshot.state,
            SpeechState::Speaking | SpeechState::Synthesizing
        ) {
            return Err(SpeechError::Busy);
        }
        Ok(reply)
    }
}

fn decode_reply(
    frame: serde_json::Value,
    request: &KeywordRequest,
) -> Result<KeywordReply, SpeechError> {
    if frame
        .as_object()
        .is_none_or(|object| !object.contains_key("detection"))
    {
        return Err(SpeechError::Protocol);
    }
    let reply: KeywordReply = serde_json::from_value(frame).map_err(|_| SpeechError::Protocol)?;
    if reply.sequence != request.sequence {
        return Err(SpeechError::Protocol);
    }
    let passive = matches!(
        request.mode,
        KeywordMode::Passive | KeywordMode::PassiveSensitive
    );
    if let Some(detection) = &reply.detection
        && ((passive && detection.command != KeywordCommand::Ivy)
            || (!passive && detection.command == KeywordCommand::Ivy)
            || (request.mode != KeywordMode::Composing
                && detection.command == KeywordCommand::PromptCancel)
            || (request.mode == KeywordMode::Composing
                && matches!(
                    detection.command,
                    KeywordCommand::Prompt | KeywordCommand::ReloadMcp
                )))
    {
        return Err(SpeechError::Protocol);
    }
    Ok(reply)
}

#[cfg(test)]
#[path = "keyword_tests.rs"]
mod tests;
