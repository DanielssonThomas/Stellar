use serde::{Deserialize, Serialize};
use ts_rs::TS;

fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetrySnapshot {
    pub schema_version: u8,
    pub sequence: u32,
    pub observed_at: String,
    pub agents: Vec<TelemetryAgent>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryAgent {
    pub id: String,
    pub name: String,
    pub project: TelemetryProject,
    pub state: TelemetryState,
    #[serde(deserialize_with = "required_option")]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub task: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub activity: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub tool: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub model: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub provider: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub usage: Option<TelemetryUsage>,
    #[serde(deserialize_with = "required_option")]
    pub started_at: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub last_observed_at: Option<String>,
    pub source: TelemetrySource,
    pub events: Vec<TelemetryEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetrySource {
    pub kind: TelemetrySourceKind,
    pub health: TelemetryHealth,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TelemetryEvent {
    #[serde(deserialize_with = "required_option")]
    pub id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub at: Option<String>,
    pub kind: TelemetryEventKind,
    pub label: String,
}

macro_rules! variants {
    ($name:ident { $($variant:ident $(=> $rename:literal)?),+ $(,)? }) => {
        #[derive(Clone, Debug, Serialize, Deserialize, TS)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name { $( $(#[serde(rename = $rename)])? $variant ),+ }
    };
}
variants!(TelemetryProject {
    Stellar,
    StellarDesign
});
variants!(TelemetryState {
    Running,
    Completed,
    Failed,
    Disconnected,
    Unknown
});
variants!(TelemetryHealth {
    Available,
    Unavailable
});
variants!(TelemetrySourceKind {
    HermesTurnLease,
    CodexLocalTurnHistory
});
variants!(TelemetryEventKind {
    Tool,
    Failure,
    Completion
});
variants!(TelemetryError {
    Unavailable,
    Timeout,
    Invalid
});
