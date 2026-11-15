use super::{Entry, Snapshot, require};
use crate::ivy::{contracts::IvyErrorCode, update_store::Updates};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) fn account(
    previous: &Updates,
    next: &mut Updates,
    s: &Snapshot,
    entries: &BTreeMap<&str, &Entry>,
    buffered: &[Value],
    tail: &[Value],
) -> Result<Vec<Value>, IvyErrorCode> {
    let mut future = BTreeMap::new();
    let frames = buffered.iter().cloned().chain(
        tail.iter()
            .map(|p| json!({"event":"gateway","data":{"params":p}})),
    );
    for frame in frames {
        if frame["event"] != "gateway"
            || frame
                .pointer("/data/params/session_id")
                .and_then(Value::as_str)
                != Some(&s.session_id)
        {
            continue;
        }
        let p = &frame["data"]["params"];
        let epoch = p["replay_epoch"].as_str().ok_or(IvyErrorCode::Uncertain)?;
        let seq = p["seq"].as_u64().ok_or(IvyErrorCode::Uncertain)?;
        if epoch == s.replay_epoch && seq > s.last_sequence {
            let canonical = json!({"event":"gateway","data":{"params":p}});
            if let Some(old) = future.insert(seq, canonical.clone()) {
                require(old == canonical)?;
            }
        } else {
            let old = previous.cursor.as_ref().is_some_and(|(e, _)| e == epoch);
            require(old || epoch == s.replay_epoch)?;
            if old
                && previous
                    .cursor
                    .as_ref()
                    .is_some_and(|(_, cursor)| seq <= *cursor)
            {
                continue;
            }
            if p["type"] == "plugin.stellar-herdr.notification.revoked" {
                let binding = &p["payload"]["binding"];
                require(p["payload"]["plugin_id"] == "stellar-herdr")?;
                let mut matched = false;
                for notice in next.notices.values_mut() {
                    if notice.descriptor["binding"] == *binding {
                        notice.revoked = true;
                        matched = true;
                    }
                }
                require(matched)?;
            } else {
                require(matches!(
                    p["type"].as_str(),
                    Some("message.start" | "message.complete")
                ))?;
                let entry = entries
                    .get(p["admission_id"].as_str().ok_or(IvyErrorCode::Uncertain)?)
                    .ok_or(IvyErrorCode::Uncertain)?;
                require(
                    p["authority_epoch"].as_u64() == Some(entry.receipt.authority_epoch)
                        && p["execution_generation"].as_u64() == entry.receipt.execution_generation,
                )?;
                if let Some(marker) = p.pointer("/payload/plugin_notification") {
                    require(entry.descriptor.as_ref() == Some(marker))?;
                }
            }
        }
    }
    require(future.len() <= 1024)?;
    Ok(future.into_values().collect())
}
