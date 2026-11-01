use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ShellRequest {
    pub version: u16,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
pub struct ShellReply {
    pub version: u16,
    pub application: String,
    pub ready: bool,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ShellError {
    UnsupportedVersion { received: u16 },
}
