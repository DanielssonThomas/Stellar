use crate::control_tests::{cancel, complete, prepare};
use crate::*;
use serde_json::{Value, json};

fn array(value: &Value, fields: &[&str]) -> Value {
    Value::Array(fields.iter().map(|key| value[*key].clone()).collect())
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn prepared() -> Value {
    serde_json::to_value(crate::tests::scope(1, 1)).unwrap()
}

#[test]
fn envelope_params_and_error_enums_reject_sequence_or_object_aliases() {
    for value in [
        json!([3,1,{"method":"prepareConsent","params":{"session_id":"s"}}]),
        json!({"version":3,"sequence":1,"request":{"method":"prepareConsent","params":["s"]}}),
        json!({"version":3,"sequence":1,"request":["prepareConsent",{"session_id":"s"}]}),
    ] {
        assert!(decode_control_request(&bytes(&value)).is_err());
    }
    assert!(decode_request(&bytes(&json!({"method":"prepareConsent","params":["s"]}))).is_err());
    for value in [
        json!(["Busy", false]),
        json!({"code":{"Busy":null},"retryAuthorized":false}),
    ] {
        assert!(decode_error(&bytes(&value)).is_err());
    }
    let expected = ControlRequest::new(1, prepare()).unwrap();
    assert!(
        decode_control_reply(
            &bytes(&json!({"version":3,"sequence":1,
        "error":["Busy",false]})),
            &expected
        )
        .is_err()
    );
}

#[test]
fn prepared_origin_and_display_scope_reject_every_object_array_alias() {
    let value = prepared();
    let origin = array(
        &value["origin"],
        &[
            "profileId",
            "sessionId",
            "physicalTarget",
            "route",
            "producerId",
            "workerIncarnation",
        ],
    );
    let display = array(
        &value["displayScope"],
        &[
            "profileLabel",
            "conversationLabel",
            "producerLabel",
            "effects",
        ],
    );
    let aliases = [
        array(
            &value,
            &[
                "version",
                "challengeId",
                "connectionBinding",
                "origin",
                "displayScope",
                "expiresAt",
                "maxAdmissions",
                "challengeExpiresAt",
            ],
        ),
        {
            let mut v = value.clone();
            v["origin"] = origin;
            v
        },
        {
            let mut v = value.clone();
            v["displayScope"] = display;
            v
        },
    ];
    let request = prepare();
    let expected = ControlRequest::new(1, prepare()).unwrap();
    for alias in aliases {
        assert!(decode_response(&request, &bytes(&alias)).is_err());
        assert!(
            decode_control_reply(
                &bytes(&json!({"version":3,"sequence":1,"result":alias})),
                &expected
            )
            .is_err()
        );
    }
    assert!(decode_response(&request, &bytes(&value)).is_ok());
}

#[test]
fn ticket_and_cancel_arrays_do_not_become_success_objects() {
    for (request, result) in [
        (complete(), json!(["a".repeat(64)])),
        (cancel(), json!([true])),
    ] {
        assert!(decode_response(&request, &bytes(&result)).is_err());
        let expected = ControlRequest::new(1, request).unwrap();
        assert!(
            decode_control_reply(
                &bytes(&json!({"version":3,"sequence":1,"result":result})),
                &expected
            )
            .is_err()
        );
    }
}

#[test]
fn code_and_artifact_manifests_require_objects_but_keep_real_vectors() {
    let value = crate::tests::manifest();
    assert!(decode_manifest(&bytes(&value)).is_ok());
    let root = array(
        &value,
        &[
            "schemaVersion",
            "purpose",
            "semanticProposalSha256",
            "contractSha256",
            "hostInterfaceSha256",
            "releaseId",
            "threatPolicy",
            "artifacts",
        ],
    );
    assert!(decode_manifest(&bytes(&root)).is_err());
    let mut artifact_alias = value.clone();
    artifact_alias["artifacts"][0] = array(
        &value["artifacts"][0],
        &["role", "path", "length", "sha256"],
    );
    assert!(decode_manifest(&bytes(&artifact_alias)).is_err());
    let mut enum_alias = value;
    enum_alias["artifacts"][0]["role"] = json!({"broker":null});
    assert!(decode_manifest(&bytes(&enum_alias)).is_err());
}

#[test]
fn fixed_launch_recipe_is_object_only_with_string_vector_flags() {
    let (value, code) = crate::launch_tests::records();
    assert!(decode_launch_manifest(&bytes(&value), &code).is_ok());
    let alias = array(
        &value,
        &[
            "schemaVersion",
            "purpose",
            "codeSetSha256",
            "profile",
            "guardian",
            "hostInterpreter",
            "hostBootstrap",
            "pythonFlags",
            "moduleSearch",
            "environment",
            "workingDirectory",
            "dllSearch",
            "inheritedHandles",
            "desktopPeer",
            "hostAuthority",
            "existingGatewayAdoption",
            "executionEnabled",
        ],
    );
    assert!(decode_launch_manifest(&bytes(&alias), &code).is_err());
    let mut wrong = value;
    wrong["pythonFlags"] = json!([["-I"], "-S", "-B"]);
    assert!(decode_launch_manifest(&bytes(&wrong), &code).is_err());
}

#[test]
fn original_duplicate_evidence_survives_shape_gate() {
    assert!(decode_control_request(br#"{"version":3,"sequence":1,"request":{"method":"prepareConsent","params":{"session_id":"s","session_id":"s"}}}"#).is_err());
    assert!(decode_error(br#"{"code":"Busy","code":"Busy","retryAuthorized":false}"#).is_err());
}
