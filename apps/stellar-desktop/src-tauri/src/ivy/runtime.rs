use super::contracts::IvyErrorCode;
use std::{fs, path::PathBuf};

pub fn python() -> Result<PathBuf, IvyErrorCode> {
    let root = PathBuf::from(r"D:\Hermes\installs");
    let mut candidates = vec![];
    for (index, entry) in fs::read_dir(&root)
        .map_err(|_| IvyErrorCode::Unavailable)?
        .take(65)
        .enumerate()
    {
        let entry = entry.map_err(|_| IvyErrorCode::Unavailable)?;
        if index >= 64 {
            return Err(IvyErrorCode::Unavailable);
        }
        let facts = entry.path().join("facts.json");
        if let Ok(metadata) = fs::metadata(&facts) {
            if metadata.len() > 65_536 {
                return Err(IvyErrorCode::Unavailable);
            }
            candidates.push((metadata.modified().ok(), facts));
        }
    }
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let (_, facts) = candidates.first().ok_or(IvyErrorCode::Unavailable)?;
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(facts).map_err(|_| IvyErrorCode::Unavailable)?)
            .map_err(|_| IvyErrorCode::Unavailable)?;
    let environment = value
        .pointer("/packages/venv/environment")
        .and_then(serde_json::Value::as_str)
        .ok_or(IvyErrorCode::Unavailable)?;
    let python = fs::canonicalize(PathBuf::from(environment).join("Scripts/python.exe"))
        .map_err(|_| IvyErrorCode::Unavailable)?;
    let root = fs::canonicalize(root).map_err(|_| IvyErrorCode::Unavailable)?;
    if !python.starts_with(root) || !python.is_file() {
        return Err(IvyErrorCode::Unavailable);
    }
    Ok(python)
}
