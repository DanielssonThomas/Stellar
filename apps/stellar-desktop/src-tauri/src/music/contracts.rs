use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MusicRequest {
    pub version: u16,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum MusicStatus {
    Idle,
    Starting,
    Capturing,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MusicLevels {
    pub level: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MusicSnapshot {
    pub version: u16,
    pub sequence: String,
    pub status: MusicStatus,
    pub levels: MusicLevels,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum MusicError {
    Malformed,
    UnsupportedVersion,
    Unavailable,
}
