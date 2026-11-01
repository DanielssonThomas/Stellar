use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum IvyComponent {
    AssistantMessage,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IvyPresentation {
    Text {
        text: String,
    },
    Component {
        component: IvyComponent,
        title: String,
        body: String,
    },
}
