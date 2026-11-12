use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const SPEECH_EVENT: &str = "speech-state";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpeechState {
    Idle,
    Collecting,
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
pub struct SpeechDuckingRequest {
    pub version: u16,
    /// Renew a six-second native lease; false starts restoration.
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechTranscribeRequest {
    pub version: u16,
    pub epoch: String,
    pub utterance_id: String,
    pub sample_rate_hz: u32,
    pub pcm: Vec<i16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub analyze_expression: Option<bool>,
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
    pub epoch: String,
    pub utterance_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechSnapshot {
    pub version: u16,
    pub epoch: String,
    pub revision: String,
    pub operation_id: Option<String>,
    pub state: SpeechState,
    pub error: Option<SpeechError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timings: Option<Vec<SpeechTiming>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpeechTimingStage {
    SynthesisStarted,
    FirstAudio,
    SynthesisCompleted,
    PlaybackDispatched,
    PlaybackCompleted,
}

/// Milliseconds since worker synthesis dispatch; playback dispatch is not acoustic onset.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechTiming {
    pub stage: SpeechTimingStage,
    pub elapsed_ms: u32,
}

impl Default for SpeechSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            epoch: "0".into(),
            revision: "0".into(),
            operation_id: None,
            state: SpeechState::Idle,
            error: None,
            timings: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpeechStopRequest {
    pub version: u16,
    pub epoch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "lowercase")]
pub enum KeywordMode {
    Passive,
    #[serde(rename = "passive_sensitive")]
    PassiveSensitive,
    Listening,
    Composing,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "lowercase")]
pub enum KeywordCommand {
    Ivy,
    Done,
    Clear,
    Prompt,
    #[serde(rename = "prompt cancel")]
    PromptCancel,
    #[serde(rename = "new session")]
    NewSession,
    #[serde(rename = "reload mcp")]
    ReloadMcp,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeywordRequest {
    pub version: u16,
    pub epoch: String,
    pub stream_id: String,
    pub sequence: u32,
    pub pcm: Vec<i16>,
    pub threshold: f32,
    pub mode: KeywordMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeywordDetection {
    pub command: KeywordCommand,
    pub end_sample: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeywordReply {
    pub sequence: u32,
    pub detection: Option<KeywordDetection>,
}
