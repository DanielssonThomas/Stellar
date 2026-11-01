use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const SPEECH_EVENT: &str = "speech-state";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpeechState {
    Idle,
    Transcribing,
    Synthesizing,
    Speaking,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpeechError {
    MalformedRequest,
    UnsupportedVersion,
    Busy,
    Unavailable,
    ModelMissing,
    Timeout,
    Cancelled,
    Protocol,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechRequest {
    pub version: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechTranscribeRequest {
    pub version: u16,
    pub utterance_id: String,
    pub sample_rate_hz: u32,
    pub pcm: Vec<i16>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechTranscript {
    pub version: u16,
    pub utterance_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechSpeakRequest {
    pub version: u16,
    pub utterance_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechSnapshot {
    pub version: u16,
    pub revision: String,
    pub operation_id: Option<String>,
    pub state: SpeechState,
    pub error: Option<SpeechError>,
}

impl Default for SpeechSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            revision: "0".into(),
            operation_id: None,
            state: SpeechState::Idle,
            error: None,
        }
    }
}
