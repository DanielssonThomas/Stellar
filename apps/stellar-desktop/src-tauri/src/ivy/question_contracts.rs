use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyQuestion {
    pub id: String,
    pub text: String,
    pub choices: Vec<String>,
    pub multi_select: bool,
    pub shown: bool,
    pub answering: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IvyQuestionAction {
    Shown,
    Answer { answer: String },
    Skip,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IvyQuestionReplyRequest {
    pub version: u16,
    pub prompt_id: String,
    pub action: IvyQuestionAction,
}
