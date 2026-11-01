use super::contracts::IvyErrorCode;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub session_id: Option<String>,
    pub input_id: Option<String>,
    pub admission_id: Option<String>,
    pub generation: Option<u64>,
    pub unsettled: bool,
}

pub struct Journal {
    path: PathBuf,
    _lock: File,
}

impl Journal {
    pub fn open(directory: &Path) -> Result<(Self, Record), IvyErrorCode> {
        fs::create_dir_all(directory).map_err(|_| IvyErrorCode::Storage)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("ivy-owner.lock"))
            .map_err(|_| IvyErrorCode::Storage)?;
        lock.try_lock().map_err(|_| IvyErrorCode::Busy)?;
        let path = directory.join("ivy-session.json");
        let record = if path.exists() {
            if fs::metadata(&path)
                .map_err(|_| IvyErrorCode::Storage)?
                .len()
                > 4096
            {
                return Err(IvyErrorCode::Storage);
            }
            serde_json::from_slice(&fs::read(&path).map_err(|_| IvyErrorCode::Storage)?)
                .map_err(|_| IvyErrorCode::Storage)?
        } else {
            Record::default()
        };
        Ok((Self { path, _lock: lock }, record))
    }

    pub fn save(&self, record: &Record) -> Result<(), IvyErrorCode> {
        let bytes = serde_json::to_vec(record).map_err(|_| IvyErrorCode::Storage)?;
        let temp = self.path.with_extension("pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
            .map_err(|_| IvyErrorCode::Storage)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| IvyErrorCode::Storage)?;
        fs::rename(&temp, &self.path).map_err(|_| IvyErrorCode::Storage)
    }
}
