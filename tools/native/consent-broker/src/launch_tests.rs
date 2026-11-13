use crate::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn records() -> (Value, Vec<u8>) {
    let code = serde_json::to_vec(&crate::tests::manifest()).unwrap();
    let hash: String = Sha256::digest(&code)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (
        json!({"schemaVersion":2,"purpose":"launch_recipe_only","codeSetSha256":hash,
        "profile":"ivy","guardian":"manifest_guardian_role",
        "hostInterpreter":"manifest_interpreter_role","hostBootstrap":"manifest_host_role",
        "pythonFlags":["-I","-S","-B"],"moduleSearch":"manifest_closure_only",
        "environment":"os_system_root_and_guardian_scratch_only",
        "workingDirectory":"guardian_private_launch_root",
        "dllSearch":"os_system32_and_pinned_closure_only",
        "inheritedHandles":"explicit_private_canonical_channel_only",
        "desktopPeer":"retained_verified_native_process",
        "hostAuthority":"new_selected_profile_instance_only",
        "existingGatewayAdoption":false,"executionEnabled":false}),
        code,
    )
}

#[test]
fn fixed_recipe_is_metadata_only() {
    let (recipe, code) = records();
    let parsed = decode_launch_manifest(&serde_json::to_vec(&recipe).unwrap(), &code).unwrap();
    assert!(!parsed.execution_enabled);
    assert!(!parsed.existing_gateway_adoption);
    assert!(matches!(Broker::unavailable(), Err(Error::HostUnverified)));
}

#[test]
fn every_recipe_field_is_fixed_and_closed() {
    let (recipe, code) = records();
    for (key, value) in recipe.as_object().unwrap() {
        let mut changed = recipe.clone();
        changed[key] = match value {
            Value::Bool(_) => json!(true),
            Value::Number(_) => json!(3),
            Value::Array(_) => json!(["-I", "-B"]),
            _ => json!("caller-controlled"),
        };
        assert!(
            decode_launch_manifest(&serde_json::to_vec(&changed).unwrap(), &code).is_err(),
            "{key}"
        );
    }
    let mut changed = recipe.clone();
    changed["argv"] = json!(["--adopt-pid", "123"]);
    assert!(decode_launch_manifest(&serde_json::to_vec(&changed).unwrap(), &code).is_err());
    let text = serde_json::to_string(&recipe).unwrap().replace(
        "\"profile\":\"ivy\"",
        "\"profile\":\"ivy\",\"profile\":\"ivy\"",
    );
    assert!(decode_launch_manifest(text.as_bytes(), &code).is_err());
}

#[test]
fn code_set_bytes_and_own_schema_must_both_match() {
    let (recipe, mut code) = records();
    code.push(b' ');
    assert!(decode_launch_manifest(&serde_json::to_vec(&recipe).unwrap(), &code).is_err());
    let mut invalid_code = crate::tests::manifest();
    invalid_code["purpose"] = json!("trust_me");
    let code = serde_json::to_vec(&invalid_code).unwrap();
    let mut matched = recipe;
    matched["codeSetSha256"] = json!(
        Sha256::digest(&code)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    assert!(decode_launch_manifest(&serde_json::to_vec(&matched).unwrap(), &code).is_err());
    assert!(decode_launch_manifest(&vec![b' '; 65_537], &code).is_err());
}
