use super::workspace_contracts::{
    WorkspaceSurface, WorkspaceToolOperation, WorkspaceToolOutcome, WorkspaceToolReply,
    WorkspaceToolRequest,
};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::{collections::HashSet, fmt};

const MAX_PAYLOAD: usize = 65536;
const MAX_PANES: usize = 4;

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn correlation(request_id: &str, epoch: &str, turn_id: &str) -> bool {
    request_id.len() == 32
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && epoch
            .parse::<u64>()
            .is_ok_and(|number| number.to_string() == epoch)
        && turn_id.len() == 36
        && turn_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn payload(value: &str, surface: &WorkspaceSurface) -> bool {
    let limit = match surface {
        WorkspaceSurface::ActivitySummary => return false,
        WorkspaceSurface::Diagram => 16384,
        WorkspaceSurface::Browser => 4096,
        WorkspaceSurface::Workflow | WorkspaceSurface::Session => 2048,
        WorkspaceSurface::RichText
        | WorkspaceSurface::Image
        | WorkspaceSurface::AssistantMessage => MAX_PAYLOAD,
    };
    if value.len() > limit {
        return false;
    }
    let mut deserializer = serde_json::Deserializer::from_str(value);
    StrictJson::deserialize(&mut deserializer).is_ok_and(|value| value.object)
        && deserializer.end().is_ok()
}

pub fn request(value: &WorkspaceToolRequest) -> bool {
    if value.version != 1
        || !correlation(&value.request_id, &value.epoch, &value.turn_id)
        || !value
            .expires_at_ms
            .parse::<u64>()
            .is_ok_and(|n| n > 0 && n.to_string() == value.expires_at_ms)
    {
        return false;
    }
    match &value.operation {
        WorkspaceToolOperation::Open {
            instance_id,
            payload_json,
            surface,
            ..
        }
        | WorkspaceToolOperation::Update {
            instance_id,
            payload_json,
            surface,
            ..
        } => identifier(instance_id) && payload(payload_json, surface),
        WorkspaceToolOperation::Remove { instance_id }
        | WorkspaceToolOperation::Focus { instance_id } => identifier(instance_id),
        WorkspaceToolOperation::Arrange { instance_ids } => {
            instance_ids.len() <= MAX_PANES
                && instance_ids.iter().all(|id| identifier(id))
                && instance_ids.iter().collect::<HashSet<_>>().len() == instance_ids.len()
        }
        WorkspaceToolOperation::Clear
        | WorkspaceToolOperation::Inspect
        | WorkspaceToolOperation::CaptureWindow => true,
    }
}

pub fn reply(request: &WorkspaceToolRequest, reply: &WorkspaceToolReply) -> bool {
    if !self::request(request)
        || reply.version != 1
        || reply.request_id != request.request_id
        || reply.epoch != request.epoch
        || reply.turn_id != request.turn_id
    {
        return false;
    }
    match (&request.operation, &reply.outcome) {
        (WorkspaceToolOperation::CaptureWindow, _) => false,
        (_, WorkspaceToolOutcome::Rejected) => true,
        (WorkspaceToolOperation::Inspect, WorkspaceToolOutcome::Inspection { panes }) => {
            panes.len() <= MAX_PANES
                && panes.iter().all(|pane| identifier(&pane.instance_id))
                && panes
                    .iter()
                    .map(|pane| &pane.instance_id)
                    .collect::<HashSet<_>>()
                    .len()
                    == panes.len()
        }
        (WorkspaceToolOperation::Inspect, _) => false,
        (_, WorkspaceToolOutcome::Applied) => true,
        _ => false,
    }
}

struct StrictJson {
    object: bool,
}

impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictJson;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("strict JSON")
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(StrictJson { object: false })
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(StrictJson { object: false })
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(StrictJson { object: false })
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                if !value.is_finite() {
                    return Err(E::custom("nonfinite"));
                }
                Ok(StrictJson { object: false })
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(StrictJson { object: false })
            }
            fn visit_string<E: de::Error>(self, _: String) -> Result<Self::Value, E> {
                Ok(StrictJson { object: false })
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictJson { object: false })
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                while sequence.next_element::<StrictJson>()?.is_some() {}
                Ok(StrictJson { object: false })
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut keys = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    map.next_value::<StrictJson>()?;
                }
                Ok(StrictJson { object: true })
            }
        }
        deserializer.deserialize_any(StrictVisitor)
    }
}
