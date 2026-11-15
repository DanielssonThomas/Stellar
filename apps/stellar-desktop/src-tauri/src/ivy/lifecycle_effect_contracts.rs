use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyLifecycleKind {
    Render,
    Speech,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyLifecycleLease {
    pub operation: String,
    pub kind: IvyLifecycleKind,
    pub text: String,
}
