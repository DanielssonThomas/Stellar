use crate::protocol::{CONTRACT, Error, HOST_INTERFACE, SEMANTICS, hex};
use crate::scope::identifier;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Broker,
    Desktop,
    Guardian,
    Interpreter,
    Host,
    Dependency,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub role: Role,
    pub path: String,
    pub length: u64,
    pub sha256: String,
}

/// Review identity only: neither deserialization nor a matching hash confers trust.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeManifest {
    pub schema_version: u32,
    pub purpose: String,
    pub semantic_proposal_sha256: String,
    pub contract_sha256: String,
    pub host_interface_sha256: String,
    pub release_id: String,
    pub threat_policy: String,
    pub artifacts: Vec<Artifact>,
}

pub fn decode_manifest(bytes: &[u8]) -> Result<CodeManifest, Error> {
    if bytes.is_empty() || bytes.len() > 65_536 {
        return Err(Error::InvalidRequest);
    }
    crate::object_json::check(bytes)?;
    let manifest: CodeManifest =
        serde_json::from_slice(bytes).map_err(|_| Error::InvalidRequest)?;
    manifest.validate()?;
    Ok(manifest)
}

impl CodeManifest {
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema_version != 2
            || self.purpose != "code_set_identity_only"
            || self.semantic_proposal_sha256 != SEMANTICS
            || self.contract_sha256 != CONTRACT
            || self.host_interface_sha256 != HOST_INTERFACE
            || self.threat_policy != "cooperative-tcb-v1"
            || !identifier(&self.release_id, 128)
            || !(5..=64).contains(&self.artifacts.len())
        {
            return Err(Error::InvalidRequest);
        }
        let mut paths = BTreeSet::new();
        let mut roots = BTreeSet::new();
        let mut total = 0_u64;
        for artifact in &self.artifacts {
            if !portable_path(&artifact.path)
                || !paths.insert(artifact.path.to_ascii_lowercase())
                || artifact.length > 4_294_967_296
                || (artifact.role != Role::Dependency && artifact.length == 0)
                || !hex(&artifact.sha256, 64)
                || (artifact.role != Role::Dependency && !roots.insert(artifact.role))
            {
                return Err(Error::InvalidRequest);
            }
            total = total
                .checked_add(artifact.length)
                .ok_or(Error::InvalidRequest)?;
        }
        if roots.len() != 5 || total > 17_179_869_184 {
            return Err(Error::InvalidRequest);
        }
        // A file path may not also serve as another artifact's directory.
        for path in &paths {
            if paths
                .iter()
                .any(|other| other.starts_with(&format!("{path}/")))
            {
                return Err(Error::InvalidRequest);
            }
        }
        Ok(())
    }
}

fn portable_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 240 || !path.is_ascii() {
        return false;
    }
    path.split('/').all(|segment| {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with('.')
            || !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return false;
        }
        let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            && !(stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    })
}
