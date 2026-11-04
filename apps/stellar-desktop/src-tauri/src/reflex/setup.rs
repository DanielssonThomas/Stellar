use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub fn configuration() -> Option<(PathBuf, PathBuf, u8)> {
    let model = PathBuf::from(std::env::var_os("STELLAR_REFLEX_MODEL")?);
    let binary = PathBuf::from(std::env::var_os("STELLAR_REFLEX_LLAMA")?);
    let layers: u8 = std::env::var("STELLAR_REFLEX_GPU_LAYERS")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .ok()?;
    if layers > 36
        || !model.is_absolute()
        || !model.is_file()
        || !binary.is_absolute()
        || !binary.is_file()
    {
        return None;
    }
    verify(&model)?;
    Some((model, binary, layers))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Provenance {
    source: String,
    revision: String,
    sha256: String,
    license: String,
}

pub fn verify(model: &Path) -> Option<()> {
    let mut raw = Vec::new();
    std::fs::File::open(model.with_extension("provenance.json"))
        .ok()?
        .take(2049)
        .read_to_end(&mut raw)
        .ok()?;
    if raw.len() > 2048 {
        return None;
    }
    let p: Provenance = serde_json::from_slice(&raw).ok()?;
    let pinned = matches!(
        (p.source.as_str(), p.revision.as_str(), p.sha256.as_str()),
        (
            "Qwen/Qwen3-1.7B-GGUF",
            "90862c4b9d2787eaed51d12237eafdfe7c5f6077",
            "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a"
        ) | (
            "Qwen/Qwen3-4B-GGUF",
            "bc640142c66e1fdd12af0bd68f40445458f3869b",
            "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"
        )
    );
    if !pinned || p.license != "Apache-2.0" {
        return None;
    }
    let mut file = std::fs::File::open(model).ok()?;
    if file.metadata().ok()?.len() > 3_000_000_000 {
        return None;
    }
    (digest(&mut file)? == p.sha256.to_lowercase()).then_some(())
}

fn digest(reader: &mut dyn Read) -> Option<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = reader.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Some(format!("{:x}", hash.finalize()))
}

pub fn token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
