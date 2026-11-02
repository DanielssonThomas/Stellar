use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CleanupRequest {
    pub version: u16,
    pub raw: String,
}

#[derive(Serialize, TS)]
pub struct CleanupReply {
    pub version: u16,
    pub text: Option<String>,
}
