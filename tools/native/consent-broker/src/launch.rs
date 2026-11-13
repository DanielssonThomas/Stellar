use crate::{CodeManifest, Error, decode_manifest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Fixed future recipe metadata. No executor or positive custody path consumes it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchManifest {
    pub schema_version: u32,
    pub purpose: String,
    pub code_set_sha256: String,
    pub profile: String,
    pub guardian: String,
    pub host_interpreter: String,
    pub host_bootstrap: String,
    pub python_flags: Vec<String>,
    pub module_search: String,
    pub environment: String,
    pub working_directory: String,
    pub dll_search: String,
    pub inherited_handles: String,
    pub desktop_peer: String,
    pub host_authority: String,
    pub existing_gateway_adoption: bool,
    pub execution_enabled: bool,
}

pub fn decode_launch_manifest(bytes: &[u8], code_set: &[u8]) -> Result<LaunchManifest, Error> {
    if bytes.is_empty() || bytes.len() > 65_536 {
        return Err(Error::InvalidRequest);
    }
    crate::object_json::check(bytes)?;
    let manifest: LaunchManifest =
        serde_json::from_slice(bytes).map_err(|_| Error::InvalidRequest)?;
    manifest.validate(code_set)?;
    Ok(manifest)
}

impl LaunchManifest {
    /// Exact byte equality binds two review records, not files or loaded processes.
    pub fn validate(&self, code_set: &[u8]) -> Result<CodeManifest, Error> {
        let code = decode_manifest(code_set)?;
        let hash: String = Sha256::digest(code_set)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if self.schema_version != 2
            || self.purpose != "launch_recipe_only"
            || self.code_set_sha256 != hash
            || self.profile != "ivy"
            || self.guardian != "manifest_guardian_role"
            || self.host_interpreter != "manifest_interpreter_role"
            || self.host_bootstrap != "manifest_host_role"
            || self.python_flags != ["-I", "-S", "-B"]
            || self.module_search != "manifest_closure_only"
            || self.environment != "os_system_root_and_guardian_scratch_only"
            || self.working_directory != "guardian_private_launch_root"
            || self.dll_search != "os_system32_and_pinned_closure_only"
            || self.inherited_handles != "explicit_private_canonical_channel_only"
            || self.desktop_peer != "retained_verified_native_process"
            || self.host_authority != "new_selected_profile_instance_only"
            || self.existing_gateway_adoption
            || self.execution_enabled
        {
            return Err(Error::InvalidRequest);
        }
        // CodeManifest validation already requires exactly one of each root role.
        Ok(code)
    }
}
