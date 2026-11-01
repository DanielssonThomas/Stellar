use super::contracts::SpeechError;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct Scratch {
    directory: PathBuf,
}
impl Scratch {
    pub fn new(root: &Path, serial: u64) -> Result<Self, SpeechError> {
        fs::create_dir_all(root).map_err(|_| SpeechError::Unavailable)?;
        let directory = root.join(format!("{}-{serial}", std::process::id()));
        fs::create_dir(&directory).map_err(|_| SpeechError::Unavailable)?;
        Ok(Self { directory })
    }
    pub fn output(&self) -> PathBuf {
        self.directory.join("reply.wav")
    }
    pub fn clean(&self) -> Result<(), SpeechError> {
        for name in ["reply.wav", "reply.tmp.wav"] {
            match fs::remove_file(self.directory.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(SpeechError::Unavailable),
            }
        }
        match fs::remove_dir(&self.directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(SpeechError::Unavailable),
        }
    }
}
