use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CaptureState {
    Idle {},
    Active { rms: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProbeRequest {
    pub version: u16,
    pub sequence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_label: Option<String>,
    pub state: CaptureState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProbeReply {
    pub version: u16,
    pub sequence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_label: Option<String>,
    pub state: CaptureState,
    pub sound_active: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProbeError {
    UnsupportedVersion { received: u16 },
    InvalidSequence {},
    InvalidLevel {},
    LabelTooLong {},
    EventUnavailable {},
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProbeEvent {
    pub version: u16,
    pub reply: ProbeReply,
}
