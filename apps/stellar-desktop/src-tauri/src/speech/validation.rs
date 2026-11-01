use super::contracts::*;
use serde::de::DeserializeOwned;

#[cfg(test)]
#[path = "validation_tests.rs"]
mod tests;

pub fn decode<T: DeserializeOwned>(value: Option<serde_json::Value>) -> Result<T, SpeechError> {
    serde_json::from_value(value.ok_or(SpeechError::MalformedRequest)?)
        .map_err(|_| SpeechError::MalformedRequest)
}

pub fn version(value: u16) -> Result<(), SpeechError> {
    if value != 1 {
        return Err(SpeechError::UnsupportedVersion);
    }
    Ok(())
}

pub fn identity(value: &str) -> Result<(), SpeechError> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        return Err(SpeechError::MalformedRequest);
    }
    Ok(())
}

pub fn transcribe(request: &SpeechTranscribeRequest) -> Result<(), SpeechError> {
    version(request.version)?;
    epoch(&request.epoch)?;
    identity(&request.utterance_id)?;
    if request.sample_rate_hz != 16_000 || request.pcm.is_empty() || request.pcm.len() > 320_000 {
        return Err(SpeechError::MalformedRequest);
    }
    Ok(())
}

pub fn speak(request: &SpeechSpeakRequest) -> Result<(), SpeechError> {
    version(request.version)?;
    epoch(&request.epoch)?;
    identity(&request.utterance_id)?;
    if request.text.trim().is_empty() || request.text.len() > 4_000 {
        return Err(SpeechError::MalformedRequest);
    }
    Ok(())
}

pub fn epoch(value: &str) -> Result<u64, SpeechError> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| SpeechError::MalformedRequest)?;
    if parsed.to_string() != value {
        return Err(SpeechError::MalformedRequest);
    }
    Ok(parsed)
}
