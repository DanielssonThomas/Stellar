use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MicrophoneReviewRequest {
    pub version: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MicrophoneReviewOutcome {
    Allowed,
    Cancelled,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MicrophoneReviewReply {
    pub version: u16,
    pub outcome: MicrophoneReviewOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MicrophoneReviewError {
    Malformed,
    UnsupportedVersion,
    Forbidden,
    Busy,
    Unsupported,
    Unavailable,
}
