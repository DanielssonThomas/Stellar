use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

pub const APP_INFO_EVENT: &str = "app-info-observed";

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AppCapability {
    NativeWindow {},
    ContractEvents {},
    #[cfg(feature = "contract-variant-fixture")]
    FutureCapability {},
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppInfoRequest {
    pub version: u16,
    pub sequence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppInfoReply {
    pub version: u16,
    pub sequence: String,
    pub application: String,
    pub capabilities: Vec<AppCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    /// Null identifies an unversioned development build without an embedded revision.
    #[serde(deserialize_with = "deserialize_build_revision")]
    pub build_revision: Option<String>,
}

// A custom deserializer makes the nullable field mandatory on input.
fn deserialize_build_revision<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case", deny_unknown_fields)]
pub enum AppInfoError {
    MalformedRequest {},
    UnsupportedVersion { received: u16 },
    InvalidSequence {},
    LabelTooLong {},
    EventUnavailable {},
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppInfoEvent {
    pub version: u16,
    pub info: AppInfoReply,
}
