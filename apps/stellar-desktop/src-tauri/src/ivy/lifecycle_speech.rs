use super::{contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_ports::*};
use crate::speech::{OwnedSpeech, SpeechCompletion, SpeechHost, contracts::SpeechSpeakRequest};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

struct Resource {
    digest: Option<[u8; 32]>,
    owned: Option<OwnedSpeech>,
}

/// Inactive native local adapter. It supplies no consent, host admission or IPC
/// registration. A future composition must check native voice preferences and
/// freshness before applying an already claimed lease.
pub struct LifecycleSpeechResources {
    host: SpeechHost,
    resources: BTreeMap<String, Resource>,
    closed: bool,
}

impl LifecycleSpeechResources {
    pub fn new(host: SpeechHost) -> Result<Self, IvyErrorCode> {
        host.claim_resource_registry()
            .map_err(|_| IvyErrorCode::Uncertain)?;
        Ok(Self {
            host,
            resources: BTreeMap::new(),
            closed: false,
        })
    }

    pub fn apply(&mut self, lease: &IvyLifecycleLease) -> Result<(), IvyErrorCode> {
        let host = self.host.clone();
        self.apply_using(lease, |request| host.speak_owned(request))
    }

    pub(crate) fn apply_using(
        &mut self,
        lease: &IvyLifecycleLease,
        start: impl FnOnce(
            SpeechSpeakRequest,
        ) -> Result<OwnedSpeech, crate::speech::contracts::SpeechError>,
    ) -> Result<(), IvyErrorCode> {
        require(
            lease.kind == IvyLifecycleKind::Speech
                && hex(&lease.operation, 32)
                && !lease.text.trim().is_empty()
                && lease.text.len() <= 262_144,
        )?;
        let digest: [u8; 32] = Sha256::digest(lease.text.as_bytes()).into();
        if let Some(old) = self.resources.get(&lease.operation) {
            require(old.digest.is_none_or(|old| old == digest))?;
            return Err(IvyErrorCode::Uncertain);
        }
        if self.closed || self.resources.len() == 32 {
            return Err(IvyErrorCode::Uncertain);
        }
        // An attempt or absent-operation fence is never retried/evicted. The real
        // native starter returns errors only before admission and always returns
        // the actual handle after admission, even if its worker later fails.
        self.resources.insert(
            lease.operation.clone(),
            Resource {
                digest: Some(digest),
                owned: None,
            },
        );
        let id = &lease.operation;
        let utterance_id = format!(
            "{}-{}-{}-{}-{}",
            &id[..8],
            &id[8..12],
            &id[12..16],
            &id[16..20],
            &id[20..]
        );
        let epoch = self
            .host
            .snapshot()
            .map_err(|_| IvyErrorCode::Uncertain)?
            .epoch;
        let text = if lease.text.len() <= 4000 {
            lease.text.clone()
        } else {
            "I have an update for you. It is available in the conversation.".into()
        };
        let owned = start(SpeechSpeakRequest {
            version: 1,
            epoch,
            utterance_id,
            text,
        })
        .map_err(|_| IvyErrorCode::Uncertain)?;
        self.resources
            .get_mut(id)
            .ok_or(IvyErrorCode::Uncertain)?
            .owned = Some(owned);
        Ok(())
    }

    pub fn completion(&self, operation: &str) -> Result<Option<SpeechCompletion>, IvyErrorCode> {
        let resource = self
            .resources
            .get(operation)
            .ok_or(IvyErrorCode::Unavailable)?;
        match &resource.owned {
            Some(owned) => owned.completion().map_err(|_| IvyErrorCode::Uncertain),
            None => Ok(None),
        }
    }

    pub fn stop(&mut self, operation: &str) -> Result<(), IvyErrorCode> {
        require(hex(operation, 32))?;
        if let Some(resource) = self.resources.get(operation) {
            if let Some(owned) = &resource.owned {
                owned.stop().map_err(|_| IvyErrorCode::Uncertain)?;
            }
            return Ok(());
        }
        if self.resources.len() == 32 {
            return Err(IvyErrorCode::Uncertain);
        }
        // No local resource was admitted; this tombstone also prevents a late
        // apply from creating one after cleanup has been acknowledged.
        self.resources.insert(
            operation.into(),
            Resource {
                digest: None,
                owned: None,
            },
        );
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), IvyErrorCode> {
        self.closed = true;
        let mut result = Ok(());
        for operation in self.resources.keys().cloned().collect::<Vec<_>>() {
            if let Err(error) = self.stop(&operation) {
                result = Err(error);
            }
        }
        result
    }
}
