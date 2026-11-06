use super::contracts::{IvyBackgroundUpdate, IvyErrorCode};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(super) const MAX_TEXT: usize = 262_144;
const MAX_STORE: u64 = 16_800_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Admission {
    pub id: String,
    pub generation: u64,
    pub authority: u64,
    pub sequence: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Updates {
    pub session: String,
    pub floor_generation: u64,
    pub settled_sequence: u64,
    pub cursor: Option<(String, u64)>,
    pub pending: Vec<Admission>,
    pub completed: Vec<IvyBackgroundUpdate>,
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
        if store.pending.len() > 16
            || store.completed.len() > 8
            || store
                .completed
                .iter()
                .any(|u| u.id.is_empty() || u.id.len() > 512 || u.text.len() > MAX_TEXT)
        {
            return Err(IvyErrorCode::Storage);
        }
        Ok(store)
    }

    pub fn save(&self, path: &Path) -> Result<(), IvyErrorCode> {
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
        if admission.generation <= self.floor_generation
            || admission.sequence <= self.settled_sequence
            || self.pending.iter().any(|a| a.id == admission.id)
        {
            return Ok(());
        }
        if self.pending.len() == 16 {
            return Err(IvyErrorCode::Uncertain);
        }
        self.pending.push(admission);
        self.pending.sort_by_key(|a| a.sequence);
        Ok(())
    }
}
