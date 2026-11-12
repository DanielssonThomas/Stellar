use super::{contracts::IvyErrorCode, lifecycle_contract::*};
use serde::{Deserialize, Serialize};

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reference {
    pub profile_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ResultText {
    pub final_response: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub admission_id: String,
    #[serde(rename = "ref")]
    pub reference: Reference,
    pub status: String,
    #[serde(deserialize_with = "required_nullable")]
    pub outcome: Option<String>,
    pub sequence: u64,
    #[serde(deserialize_with = "required_nullable")]
    pub authority_epoch: Option<u64>,
    #[serde(deserialize_with = "required_nullable")]
    pub execution_generation: Option<u64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<ResultText>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Inspection {
    pub schema_version: u16,
    pub status: String,
    pub retry_authorized: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub descriptor: Option<Descriptor>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub delivery_authorized: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub receipt: Option<Receipt>,
}

impl Inspection {
    pub fn validate(&self, expected: &Descriptor) -> Result<(), IvyErrorCode> {
        require(self.schema_version == 1 && !self.retry_authorized && expected.valid())?;
        if let Some(descriptor) = &self.descriptor {
            require(descriptor == expected)?;
        }
        if self.status == "unknown" {
            require(self.delivery_authorized != Some(true))?;
            return Err(IvyErrorCode::Uncertain);
        }
        require(self.descriptor.as_ref() == Some(expected) && self.delivery_authorized.is_some())?;
        let r = self.receipt.as_ref().ok_or(IvyErrorCode::Protocol)?;
        require(
            id(&r.admission_id, 512)
                && (1..=SAFE).contains(&r.sequence)
                && r.reference.profile_id == expected.origin.profile_id
                && r.reference.session_id == expected.origin.session_id
                && r.authority_epoch.is_none_or(|v| v <= SAFE)
                && r.execution_generation.is_none_or(|v| v <= SAFE),
        )?;
        if self.status == "admitted" {
            require(
                matches!(r.status.as_str(), "queued" | "started")
                    && r.outcome.is_none()
                    && r.result.is_none()
                    && self.delivery_authorized == Some(false),
            )?;
        } else {
            require(
                self.status == "terminal"
                    && r.status == "terminal"
                    && matches!(
                        r.outcome.as_deref(),
                        Some("completed" | "failed" | "cancelled" | "interrupted")
                    ),
            )?;
        }
        if let Some(result) = &r.result {
            require(result.final_response.len() <= 262_144)?;
        }
        if self.delivery_authorized == Some(true) {
            require(
                r.status == "terminal"
                    && r.outcome.as_deref() == Some("completed")
                    && r.result
                        .as_ref()
                        .is_some_and(|v| !v.final_response.trim().is_empty())
                    && r.authority_epoch.is_some()
                    && r.execution_generation.is_some(),
            )?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EffectBegin {
    pub status: String,
    pub execute: bool,
}

impl EffectBegin {
    pub fn validate(&self) -> Result<(), IvyErrorCode> {
        require(matches!(
            (self.status.as_str(), self.execute),
            ("claimed", true) | ("unknown" | "finished", false)
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Revocation {
    pub status: String,
    pub revocation_committed: bool,
    pub effects_stopped: bool,
}

impl Revocation {
    pub fn validate(&self) -> Result<(), IvyErrorCode> {
        require(matches!(
            (
                self.status.as_str(),
                self.revocation_committed,
                self.effects_stopped
            ),
            ("active", false, false) | ("revoking", true, false) | ("revoked", true, true)
        ))
    }
}
