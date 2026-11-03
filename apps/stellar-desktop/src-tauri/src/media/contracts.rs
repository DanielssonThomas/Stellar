use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserAction {
    Open {
        id: String,
        generation: u32,
        url: String,
        bounds: BrowserBounds,
    },
    Navigate {
        id: String,
        generation: u32,
        url: String,
    },
    Bounds {
        id: String,
        bounds: BrowserBounds,
    },
    Back {
        id: String,
        generation: u32,
    },
    Forward {
        id: String,
        generation: u32,
    },
    Reload {
        id: String,
        generation: u32,
    },
    Close {
        id: String,
    },
    External {
        url: String,
    },
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserRequest {
    pub version: u16,
    pub operation: BrowserAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MediaError {
    Malformed,
    Blocked,
    Limit,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLoadState {
    Loading,
    Ready,
    Blocked,
    Failed,
    Focused,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct BrowserEvent {
    pub id: String,
    pub generation: u32,
    pub url: String,
    pub state: BrowserLoadState,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ImageRequest {
    pub version: u16,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ImagePreview {
    pub data_uri: String,
    pub width: u32,
    pub height: u32,
}
