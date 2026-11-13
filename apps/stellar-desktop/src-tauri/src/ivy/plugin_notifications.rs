use super::{
    background_updates::identity,
    contracts::*,
    session::Session,
    update_store::{Admission, Updates},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Notice {
    pub descriptor: Value,
    pub admission: Admission,
    pub revoked: bool,
}

fn text(v: Option<&Value>, max: usize) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.len() <= max && !s.contains('\0'))
}
fn closed(v: &Value, fields: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.len() == fields.len() && fields.iter().all(|f| m.contains_key(*f)))
}
pub(super) fn descriptor(v: &Value, session: &str) -> bool {
    let b = &v["binding"];
    let fields = [
        "profile_id",
        "session_id",
        "owner_session_id",
        "session_key",
        "plugin_id",
        "tracking_id",
    ];
    if !closed(
        v,
        &["schema_version", "binding", "event_id", "payload_digest"],
    ) || v["schema_version"].as_u64() != Some(1)
        || !closed(
            b,
            &[
                "binding_id",
                "profile_id",
                "session_id",
                "owner_session_id",
                "session_key",
                "plugin_id",
                "tracking_id",
                "revision",
                "expires_at",
            ],
        )
        || fields.iter().any(|f| !text(b.get(*f), 1024))
        || b["owner_session_id"].as_str() != Some(session)
        || b["plugin_id"] != "stellar-herdr"
        || !b["revision"].as_u64().is_some_and(|n| n > 0)
        || !b["expires_at"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0)
        || !hex(&v["event_id"])
        || !hex(&v["payload_digest"])
        || !hex(&b["binding_id"])
    {
        return false;
    }
    let identity: std::collections::BTreeMap<String, Value> = fields
        .iter()
        .map(|f| ((*f).into(), b[*f].clone()))
        .collect();
    serde_json::to_vec(&identity).is_ok_and(|bytes| {
        b["binding_id"].as_str() == Some(format!("{:x}", Sha256::digest(bytes)).as_str())
    })
}
fn hex(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
impl Notice {
    pub fn valid(&self, session: &str, id: &str) -> bool {
        self.admission.id == id && descriptor(&self.descriptor, session)
    }
}

pub(super) struct Inspection {
    pub receipt: Value,
    pub text: Option<String>,
    pub allowed: bool,
    pub retired: bool,
}

impl Session {
    pub(super) fn inspect_notice(&mut self, notice: &Notice) -> Result<Inspection, IvyErrorCode> {
        let result = self.inspect_notice_raw(notice);
        if result.is_err() {
            let legacy = self
                .record
                .session_id
                .as_deref()
                .and_then(|s| Updates::load(&self.journal.updates_path(), s).ok())
                .map(|u| {
                    u.completed
                        .into_iter()
                        .filter(|v| !u.notices.contains_key(&v.id))
                        .collect()
                })
                .unwrap_or_default();
            self.publish_updates(legacy);
        }
        result
    }

    fn inspect_notice_raw(&mut self, notice: &Notice) -> Result<Inspection, IvyErrorCode> {
        let session = self
            .record
            .session_id
            .clone()
            .ok_or(IvyErrorCode::Protocol)?;
        let value = self.call("stellar.notification.inspect", json!({
            "session_id":session,"admission_id":notice.admission.id,"descriptor":notice.descriptor
        }))?;
        let host = &value["host"];
        if !closed(&value, &["host", "local_eligible", "delivery_allowed"])
            || value["local_eligible"].as_bool().is_none()
            || value["delivery_allowed"].as_bool().is_none()
            || host["binding"] != notice.descriptor["binding"]
            || host["event_id"] != notice.descriptor["event_id"]
        {
            return Err(IvyErrorCode::Protocol);
        }
        if host["status"] == "unknown" {
            return Err(IvyErrorCode::Uncertain);
        }
        if host["status"] != "known"
            || !closed(
                host,
                &[
                    "status",
                    "binding",
                    "event_id",
                    "descriptor",
                    "receipt",
                    "result",
                    "delivery_allowed",
                ],
            )
            || host["delivery_allowed"].as_bool().is_none()
            || (!host["descriptor"].is_null() && host["descriptor"] != notice.descriptor)
        {
            return Err(IvyErrorCode::Protocol);
        }
        let receipt = &host["receipt"];
        if !closed(
            receipt,
            &[
                "admission_id",
                "ref",
                "sequence",
                "status",
                "outcome",
                "authority_epoch",
                "execution_generation",
            ],
        ) || !closed(&receipt["ref"], &["profile_id", "session_id"])
            || receipt["admission_id"].as_str() != Some(&notice.admission.id)
            || receipt.pointer("/ref/session_id").and_then(Value::as_str) != Some(&session)
            || receipt.pointer("/ref/profile_id")
                != notice.descriptor.pointer("/binding/profile_id")
            || !receipt["sequence"].as_u64().is_some_and(|n| {
                n > 0 && (notice.admission.sequence == 0 || n == notice.admission.sequence)
            })
        {
            return Err(IvyErrorCode::Protocol);
        }
        let text = host
            .pointer("/result/result/final_response")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let meaningful = text
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= super::update_store::MAX_TEXT);
        let allowed = value["delivery_allowed"] == true;
        if allowed
            != (value["local_eligible"] == true && host["delivery_allowed"] == true && meaningful)
        {
            return Err(IvyErrorCode::Protocol);
        }
        if (matches!(receipt["status"].as_str(), Some("started"))
            || (receipt["status"] == "terminal" && receipt["outcome"] == "completed"))
            && (receipt["execution_generation"].as_u64() != Some(notice.admission.generation)
                || receipt["authority_epoch"].as_u64() != Some(notice.admission.authority))
        {
            return Err(IvyErrorCode::Protocol);
        }
        if allowed
            && (host["descriptor"].is_null()
                || receipt["status"] != "terminal"
                || receipt["outcome"] != "completed"
                || receipt["execution_generation"].as_u64() != Some(notice.admission.generation)
                || receipt["authority_epoch"].as_u64() != Some(notice.admission.authority)
                || text
                    .as_ref()
                    .is_none_or(|s| s.trim().is_empty() || s.len() > super::update_store::MAX_TEXT))
        {
            return Err(IvyErrorCode::Protocol);
        }
        Ok(Inspection {
            receipt: receipt.clone(),
            text,
            allowed: allowed && !notice.revoked,
            retired: host["descriptor"].is_null()
                || (receipt["status"] == "terminal" && !meaningful),
        })
    }

    pub(super) fn plugin_event(&mut self, params: &Value) -> Result<bool, IvyErrorCode> {
        let session = self
            .record
            .session_id
            .clone()
            .ok_or(IvyErrorCode::Protocol)?;
        let path = self.journal.updates_path();
        let mut updates = Updates::load(&path, &session)?;
        let id = params["admission_id"].as_str();
        if params["type"] == "plugin.stellar-herdr.notification.revoked" {
            let payload = &params["payload"];
            if !closed(payload, &["plugin_id", "binding", "in_flight"])
                || payload["plugin_id"] != "stellar-herdr"
                || payload["binding"]["owner_session_id"].as_str() != Some(&session)
                || payload["in_flight"].as_array().is_none()
            {
                return Err(IvyErrorCode::Protocol);
            }
            for notice in updates.notices.values_mut() {
                if notice.descriptor["binding"] == payload["binding"] {
                    notice.revoked = true;
                }
            }
            updates.save(&path)?;
            self.publish_checked_updates(&updates)?;
            return Ok(true);
        }
        let marked = params.pointer("/payload/plugin_notification");
        let known = id.and_then(|id| updates.notices.get(id)).cloned();
        if let Some(known) = &known {
            if marked.is_some_and(|v| v != &known.descriptor) {
                return Err(IvyErrorCode::Protocol);
            }
            if params["type"] == "message.complete" {
                let stamp = identity(params)?;
                if stamp.authority != known.admission.authority
                    || stamp.generation != known.admission.generation
                {
                    return Err(IvyErrorCode::Protocol);
                }
            }
        } else if marked.is_some() && params["type"] != "message.start" {
            return Err(IvyErrorCode::Uncertain);
        }
        if (marked.is_some() || known.is_some())
            && params.pointer("/payload/background_v1").is_some()
        {
            return Err(IvyErrorCode::Protocol);
        }
        if marked.is_none() && known.is_none() {
            return Ok(false);
        }
        if !matches!(
            params["type"].as_str(),
            Some("message.start" | "message.complete")
        ) {
            return Ok(true);
        }
        if self.record.unsettled && self.record.admission_id.is_none() {
            return Err(IvyErrorCode::Uncertain);
        }
        if id == self.record.admission_id.as_deref() {
            return Err(IvyErrorCode::Protocol);
        }
        if params["type"] == "message.start" {
            let value = marked.ok_or(IvyErrorCode::Protocol)?;
            if !descriptor(value, &session) {
                return Err(IvyErrorCode::Protocol);
            }
            let mut admission = identity(params)?;
            if known.is_none()
                && updates
                    .cursor
                    .as_ref()
                    .is_some_and(|(_, seq)| params["seq"].as_u64().is_some_and(|n| n <= *seq))
            {
                return Ok(true);
            }
            let mut notice = Notice {
                descriptor: value.clone(),
                admission: admission.clone(),
                revoked: known.as_ref().is_some_and(|n| n.revoked),
            };
            let inspected = self.inspect_notice(&notice)?;
            admission.sequence = inspected.receipt["sequence"]
                .as_u64()
                .ok_or(IvyErrorCode::Protocol)?;
            notice.admission = admission.clone();
            if known
                .as_ref()
                .is_some_and(|n| n.descriptor != *value || n.admission != admission)
            {
                return Err(IvyErrorCode::Protocol);
            }
            if known.is_none()
                && (updates.pending.iter().any(|a| a.id == admission.id)
                    || updates.completed.iter().any(|u| u.id == admission.id))
            {
                return Err(IvyErrorCode::Protocol);
            }
            updates.admit(admission.clone())?;
            if updates.pending.iter().any(|a| a.id == admission.id) || known.is_some() {
                updates.notices.insert(admission.id.clone(), notice);
            }
            updates.save(&path)?;
        }
        self.poll_updates()?;
        Ok(true)
    }

    pub(super) fn publish_checked_updates(
        &mut self,
        updates: &Updates,
    ) -> Result<(), IvyErrorCode> {
        let mut visible = vec![];
        for update in &updates.completed {
            if let Some(notice) = updates.notices.get(&update.id) {
                if notice.revoked {
                    continue;
                }
                match self.inspect_notice(notice) {
                    Ok(inspected) if inspected.allowed => {
                        if inspected
                            .text
                            .as_deref()
                            .map(super::background_updates::answer_text)
                            .as_deref()
                            != Some(&update.text)
                        {
                            self.publish_updates(
                                updates
                                    .completed
                                    .iter()
                                    .filter(|u| !updates.notices.contains_key(&u.id))
                                    .cloned()
                                    .collect(),
                            );
                            return Err(IvyErrorCode::Protocol);
                        }
                        visible.push(update.clone());
                    }
                    Ok(_) => {}
                    Err(error) => {
                        self.publish_updates(
                            updates
                                .completed
                                .iter()
                                .filter(|u| !updates.notices.contains_key(&u.id))
                                .cloned()
                                .collect(),
                        );
                        return Err(error);
                    }
                }
            } else {
                visible.push(update.clone());
            }
        }
        self.publish_updates(visible);
        Ok(())
    }
}
