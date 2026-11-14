use super::workspace_contracts::{
    BATCH_MAX_OPERATIONS, BATCH_MAX_PAYLOAD_BYTES, WorkspacePaneMetadata, WorkspaceSurface,
    WorkspaceToolOperation, WorkspaceToolOutcome, WorkspaceToolReply, WorkspaceToolRequest,
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
        WorkspaceSurface::Chart => 16384,
        WorkspaceSurface::GithubIssue => 16384,
        WorkspaceSurface::Browser => 4096,
        WorkspaceSurface::Workflow | WorkspaceSurface::Session => 2048,
        WorkspaceSurface::RichText
        | WorkspaceSurface::Image
        | WorkspaceSurface::AssistantMessage => MAX_PAYLOAD,
    };
    object_payload(value, limit)
        && match surface {
            WorkspaceSurface::Chart => super::chart_validate::payload(value),
            WorkspaceSurface::GithubIssue => super::issue_validate::payload(value),
            WorkspaceSurface::RichText => super::chart_validate::inline(value),
            _ => true,
        }
}

pub(super) fn object_payload(value: &str, limit: usize) -> bool {
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
    operation(&value.operation)
}

pub(super) fn mutation(value: &WorkspaceToolOperation) -> bool {
    matches!(
        value,
        WorkspaceToolOperation::Open { .. }
            | WorkspaceToolOperation::Update { .. }
            | WorkspaceToolOperation::Remove { .. }
            | WorkspaceToolOperation::Focus { .. }
            | WorkspaceToolOperation::Minimize { .. }
            | WorkspaceToolOperation::Restore { .. }
            | WorkspaceToolOperation::Maximize { .. }
            | WorkspaceToolOperation::Resize { .. }
            | WorkspaceToolOperation::Swap { .. }
            | WorkspaceToolOperation::RestoreLayout
            | WorkspaceToolOperation::Arrange { .. }
            | WorkspaceToolOperation::Clear
    )
}

fn operation(value: &WorkspaceToolOperation) -> bool {
    match value {
        WorkspaceToolOperation::Batch { operations } => {
            !operations.is_empty()
                && operations.len() <= BATCH_MAX_OPERATIONS
                && operations
                    .iter()
                    .all(|entry| mutation(entry) && operation(entry))
                && operations
                    .iter()
                    .map(|entry| match entry {
                        WorkspaceToolOperation::Open { payload_json, .. }
                        | WorkspaceToolOperation::Update { payload_json, .. } => payload_json.len(),
                        _ => 0,
                    })
                    .sum::<usize>()
                    <= BATCH_MAX_PAYLOAD_BYTES
        }
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
        | WorkspaceToolOperation::Focus { instance_id }
        | WorkspaceToolOperation::Minimize { instance_id }
        | WorkspaceToolOperation::Restore { instance_id }
        | WorkspaceToolOperation::Maximize { instance_id }
        | WorkspaceToolOperation::InspectContent { instance_id } => identifier(instance_id),
        WorkspaceToolOperation::Resize {
            instance_id,
            percent,
        } => identifier(instance_id) && (10..=90).contains(percent),
        WorkspaceToolOperation::Swap {
            instance_id,
            other_id,
        } => identifier(instance_id) && identifier(other_id) && instance_id != other_id,
        WorkspaceToolOperation::Arrange { instance_ids } => {
            instance_ids.len() <= MAX_PANES
                && instance_ids.iter().all(|id| identifier(id))
                && instance_ids.iter().collect::<HashSet<_>>().len() == instance_ids.len()
        }
        WorkspaceToolOperation::Present { score_json } => {
            object_payload(score_json, 32768) && super::issue_validate::spatial(score_json)
        }
        WorkspaceToolOperation::Clear
        | WorkspaceToolOperation::ListDisplays
        | WorkspaceToolOperation::CaptureForeground
        | WorkspaceToolOperation::RestoreLayout
        | WorkspaceToolOperation::Inspect
        | WorkspaceToolOperation::CaptureWindow => true,
        WorkspaceToolOperation::CaptureDisplay { display_id } => {
            display_id.as_deref().is_none_or(display_id_valid)
        }
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
        (
            WorkspaceToolOperation::Batch { operations },
            WorkspaceToolOutcome::Batch { outcomes, panes },
        ) => {
            outcomes.len() == operations.len()
                && panes.as_ref().is_none_or(|value| valid_panes(value))
        }
        (WorkspaceToolOperation::Batch { .. }, WorkspaceToolOutcome::Rejected) => true,
        (WorkspaceToolOperation::Batch { .. }, _) => false,
        (
            WorkspaceToolOperation::CaptureWindow
            | WorkspaceToolOperation::CaptureForeground
            | WorkspaceToolOperation::CaptureDisplay { .. }
            | WorkspaceToolOperation::ListDisplays,
            _,
        ) => false,
        (_, WorkspaceToolOutcome::Rejected) => true,
        (WorkspaceToolOperation::Inspect, WorkspaceToolOutcome::Inspection { panes }) => {
            valid_panes(panes)
        }
        (WorkspaceToolOperation::Inspect, _) => false,
        (
            WorkspaceToolOperation::InspectContent {
                instance_id: requested,
            },
            WorkspaceToolOutcome::Content {
                instance_id,
                surface,
                payload_json,
                ..
            },
        ) => requested == instance_id && payload(payload_json, surface),
        (WorkspaceToolOperation::InspectContent { .. }, _) => false,
        (_, WorkspaceToolOutcome::Applied) => true,
        _ => false,
    }
}

fn valid_panes(panes: &[WorkspacePaneMetadata]) -> bool {
    panes.len() <= MAX_PANES
        && panes.iter().all(|pane| {
            identifier(&pane.instance_id)
                && pane.operations.len() <= 14
                && pane.operations.iter().collect::<HashSet<_>>().len() == pane.operations.len()
                && pane.layout.as_ref().is_none_or(|layout| {
                    layout.title.chars().count() <= 240
                        && layout.position < 4
                        && [layout.x, layout.y, layout.width, layout.height]
                            .iter()
                            .all(|n| *n <= 1000)
                        && layout.x + layout.width <= 1001
                        && layout.y + layout.height <= 1001
                })
        })
        && panes
            .iter()
            .map(|pane| &pane.instance_id)
            .collect::<HashSet<_>>()
            .len()
            == panes.len()
}

pub fn display_id_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
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
