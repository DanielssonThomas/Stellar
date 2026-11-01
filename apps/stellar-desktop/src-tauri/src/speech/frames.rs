use super::{contracts::SpeechError, process::Frames};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[cfg(test)]
#[path = "frames_tests.rs"]
mod tests;

pub fn collect(
    cancelled: &AtomicBool,
    mode: &str,
    frames: Frames,
    deadline: Instant,
    mut on_speaking: impl FnMut() -> Result<(), SpeechError>,
) -> Result<String, SpeechError> {
    let mut started = false;
    let mut speaking = false;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(SpeechError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(SpeechError::Timeout);
        }
        let frame = match frames.recv_timeout(Duration::from_millis(20)) {
            Ok(frame) => frame?,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => return Err(SpeechError::Unavailable),
        };
        let object = frame
            .as_object()
            .filter(|value| value.len() == 1)
            .ok_or(SpeechError::Protocol)?;
        if let Some(error) = object.get("error") {
            return Err(match error.as_str() {
                Some("model_missing") => SpeechError::ModelMissing,
                Some("unavailable") => SpeechError::Unavailable,
                Some("protocol") => SpeechError::Protocol,
                _ => return Err(SpeechError::Protocol),
            });
        }
        if let Some(state) = object.get("state").and_then(Value::as_str) {
            match (mode, state, started, speaking) {
                ("transcribe", "transcribing", false, false)
                | ("speak", "synthesizing", false, false) => started = true,
                ("speak", "speaking", true, false) => {
                    speaking = true;
                    on_speaking()?;
                }
                _ => return Err(SpeechError::Protocol),
            }
            continue;
        }
        if mode == "transcribe" && started {
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| text.len() <= 8192)
                .ok_or(SpeechError::Protocol)?;
            return Ok(text.to_owned());
        }
        if mode == "speak" && speaking && object.get("done") == Some(&Value::Bool(true)) {
            return Ok(String::new());
        }
        return Err(SpeechError::Protocol);
    }
}
