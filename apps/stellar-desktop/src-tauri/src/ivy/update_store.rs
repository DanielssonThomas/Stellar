use super::contracts::{IvyBackgroundUpdate, IvyErrorCode};
use super::plugin_notifications::Notice;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(super) const MAX_TEXT: usize = 262_144;
const MAX_STORE: u64 = 16_800_000;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Admission {
    pub id: String,
    pub generation: u64,
    pub authority: u64,
    pub sequence: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Updates {
    pub session: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recovery_pending: bool,
    pub floor_generation: u64,
    pub settled_sequence: u64,
    pub cursor: Option<(String, u64)>,
    pub pending: Vec<Admission>,
    pub completed: Vec<IvyBackgroundUpdate>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub notices: BTreeMap<String, Notice>,
}

impl Updates {
    pub fn load(path: &Path, session: &str) -> Result<Self, IvyErrorCode> {
        let mut store = if path.exists() {
            if fs::metadata(path).map_err(|_| IvyErrorCode::Storage)?.len() > MAX_STORE {
                return Err(IvyErrorCode::Storage);
            }
            serde_json::from_slice::<Self>(&fs::read(path).map_err(|_| IvyErrorCode::Storage)?)
                .map_err(|_| IvyErrorCode::Storage)?
        } else {
            Self::default()
        };
        if store.session != session {
            store = Self {
                session: session.into(),
                ..Self::default()
            };
        }
        if !store.valid() {
            return Err(IvyErrorCode::Storage);
        }
        Ok(store)
    }

    pub fn save(&self, path: &Path) -> Result<(), IvyErrorCode> {
        if !self.valid() {
            return Err(IvyErrorCode::Storage);
        }
        let bytes = serde_json::to_vec(self).map_err(|_| IvyErrorCode::Storage)?;
        if bytes.len() as u64 > MAX_STORE {
            return Err(IvyErrorCode::Storage);
        }
        let temporary = path.with_extension("pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|_| IvyErrorCode::Storage)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| IvyErrorCode::Storage)?;
        fs::rename(temporary, path).map_err(|_| IvyErrorCode::Storage)
    }

    pub fn admit(&mut self, admission: Admission) -> Result<(), IvyErrorCode> {
        if !bounded_id(&admission.id) {
            return Err(IvyErrorCode::Protocol);
        }
        if let Some(previous) = self.pending.iter().find(|a| a.id == admission.id) {
            return if previous == &admission {
                Ok(())
            } else {
                Err(IvyErrorCode::Protocol)
            };
        }
        if admission.generation <= self.floor_generation {
            return Ok(());
        }
        if admission.sequence <= self.settled_sequence {
            return Ok(());
        }
        if self
            .pending
            .iter()
            .any(|a| a.sequence == admission.sequence)
            || self.completed.iter().any(|u| u.id == admission.id)
        {
            return Err(IvyErrorCode::Protocol);
        }
        if self.pending.len() == 16 {
            return Err(IvyErrorCode::Uncertain);
        }
        self.pending.push(admission);
        self.pending.sort_by_key(|a| a.sequence);
        Ok(())
    }

    fn valid(&self) -> bool {
        self.pending.len() <= 16
            && self.completed.len() <= 8
            && self.notices.len() <= 24
            && self.notices.iter().all(|(id, n)| {
                n.valid(&self.session, id)
                    && (self.pending.iter().any(|a| a == &n.admission)
                        || self.completed.iter().any(|u| &u.id == id))
            })
            && self
                .cursor
                .as_ref()
                .is_none_or(|(epoch, _)| bounded_id(epoch))
            && self.pending.iter().enumerate().all(|(i, item)| {
                bounded_id(&item.id)
                    && item.generation > self.floor_generation
                    && item.sequence > self.settled_sequence
                    && self.pending[..i]
                        .iter()
                        .all(|prior| prior.id != item.id && prior.sequence < item.sequence)
                    && self.completed.iter().all(|done| done.id != item.id)
            })
            && self.completed.iter().enumerate().all(|(i, item)| {
                bounded_id(&item.id)
                    && item.text.len() <= MAX_TEXT
                    && item
                        .speech_claim
                        .as_ref()
                        .is_none_or(|claim| bounded_id(claim))
                    && self.completed[..i].iter().all(|prior| prior.id != item.id)
            })
    }
}

fn bounded_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512
}
