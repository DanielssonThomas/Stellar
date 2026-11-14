use super::{contracts::IvyErrorCode, lifecycle_custody::*, lifecycle_ports::*};
use serde_json::{Value, json};
use std::path::PathBuf;

struct Ports {
    path: PathBuf,
    transport: String,
    fixture: Value,
    calls: Vec<String>,
    applied: Vec<String>,
    stopped: Vec<String>,
    fail: Option<String>,
    inspect_count: usize,
    deny_after_begin: bool,
    begin: Value,
    ticket: bool,
}
impl LifecyclePorts for Ports {
    fn transport(&self) -> &str {
        &self.transport
    }
    fn now(&self) -> Result<u64, IvyErrorCode> {
        Ok(self.fixture["now"].as_u64().unwrap())
    }
    fn consent_ticket(&mut self, _: &str) -> Result<String, IvyErrorCode> {
        if !self.ticket {
            return Err(IvyErrorCode::ApprovalRequired);
        }
        Ok("f".repeat(64))
    }
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, IvyErrorCode> {
        self.calls.push(method.into());
        assert_eq!(params["session_id"], "session");
        assert!(params.get("client").is_none() && params.get("profileId").is_none());
        if method.ends_with(".bind") {
            assert!(
                LifecycleCustody::read(&self.path, "session")
                    .unwrap()
                    .bind_uncertain
                    .is_some()
            );
        }
        if method.ends_with(".begin") {
            let saved = LifecycleCustody::read(&self.path, "session").unwrap();
            let intent = saved.intents.last().unwrap();
            assert!(intent.phase == Phase::Pending);
            assert_eq!(intent.operation, params["operation"].as_str().unwrap());
            assert_eq!(params["bindingId"], self.fixture["binding"]["bindingId"]);
        }
        if method.ends_with(".finish") {
            let op = params["operation"].as_str().unwrap();
            assert!(self.stopped.iter().any(|s| s == op));
            assert!(
                LifecycleCustody::read(&self.path, "session")
                    .unwrap()
                    .intents
                    .iter()
                    .find(|i| i.operation == op)
                    .unwrap()
                    .phase
                    == Phase::Stopped
            );
        }
        if self.fail.as_deref() == Some(method) {
            return Err(IvyErrorCode::Timeout);
        }
        match method {
            "stellar.background.bind" => Ok(self.fixture["binding"].clone()),
            "stellar.background.inspect" => {
                self.inspect_count += 1;
                let mut value = self.fixture["inspection"].clone();
                if self.deny_after_begin && self.inspect_count >= 2 {
                    value["deliveryAuthorized"] = json!(false);
                }
                Ok(value)
            }
            "stellar.background.effect.begin" => Ok(self.begin.clone()),
            "stellar.background.effect.finish" => {
                Ok(json!({"status":"active","revocationCommitted":false,"effectsStopped":false}))
            }
            "stellar.background.revoke" => {
                if self.fail.as_deref() != Some("stop") {
                    assert_eq!(self.applied.len(), self.stopped.len());
                }
                Ok(json!({"status":"revoking","revocationCommitted":true,"effectsStopped":false}))
            }
            _ => panic!("unexpected RPC {method}"),
        }
    }
    fn apply(&mut self, lease: &IvyLifecycleLease) -> Result<(), IvyErrorCode> {
        let saved = LifecycleCustody::read(&self.path, "session").unwrap();
        assert!(
            saved
                .intents
                .iter()
                .find(|i| i.operation == lease.operation)
                .unwrap()
                .phase
                == Phase::Claimed
        );
        self.applied.push(lease.operation.clone());
        Ok(())
    }
    fn stop(&mut self, operation: &str, _: IvyLifecycleKind) -> Result<(), IvyErrorCode> {
        if self.fail.as_deref() == Some("stop") {
            return Err(IvyErrorCode::Uncertain);
        }
        if !self.stopped.iter().any(|s| s == operation) {
            self.stopped.push(operation.into());
        }
        Ok(())
    }
}
fn fixture() -> (LifecycleCustody, Ports, PathBuf) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/lifecycle-v1.json"
    ))
    .unwrap();
    let directory = std::env::temp_dir().join(format!("stellar-custody-{}", operation().unwrap()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("custody.json");
    let transport = "a".repeat(32);
    let custody = LifecycleCustody::open(path.clone(), "session", &transport).unwrap();
    let binding = serde_json::from_value(fixture["binding"].clone()).unwrap();
    let inspection = serde_json::from_value(fixture["inspection"].clone()).unwrap();
    let mut staged = super::lifecycle_store::Staging {
        session: "session".into(),
        ..Default::default()
    };
    staged
        .observe(
            &binding,
            inspection,
            "epoch",
            1,
            fixture["now"].as_u64().unwrap(),
        )
        .unwrap();
    staged.save(&custody.staging_path()).unwrap();
    let ports = Ports {
        path,
        transport,
        fixture,
        calls: vec![],
        applied: vec![],
        stopped: vec![],
        fail: None,
        inspect_count: 0,
        deny_after_begin: false,
        begin: json!({"status":"claimed","execute":true}),
        ticket: true,
    };
    (custody, ports, directory)
}

#[test]
fn consent_requires_native_adapter_and_lost_ack_stays_uncertain_across_restart() {
    let (mut custody, mut ports, directory) = fixture();
    ports.ticket = false;
    assert_eq!(
        custody.consent(&mut ports),
        Err(IvyErrorCode::ApprovalRequired)
    );
    assert!(ports.calls.is_empty() && !ports.path.exists());
    ports.ticket = true;
    ports.fail = Some("stellar.background.bind".into());
    assert_eq!(custody.consent(&mut ports), Err(IvyErrorCode::Timeout));
    assert_eq!(custody.consent(&mut ports), Err(IvyErrorCode::Uncertain));
    assert_eq!(ports.calls.len(), 1);
    drop(custody);
    ports.fail = None;
    let mut custody =
        LifecycleCustody::open(ports.path.clone(), "session", &ports.transport).unwrap();
    assert_eq!(custody.consent(&mut ports), Err(IvyErrorCode::Uncertain));
    assert_eq!(ports.calls.len(), 1);
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn render_and_speech_hold_distinct_durable_custody_until_actual_local_stop() {
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for kind in [IvyLifecycleKind::Render, IvyLifecycleKind::Speech] {
        custody.deliver(&mut ports, &staged, kind).unwrap();
        assert_eq!(
            custody.deliver(&mut ports, &staged, kind),
            Err(IvyErrorCode::Uncertain)
        );
    }
    assert_eq!(ports.applied.len(), 2);
    assert!(ports.stopped.is_empty());
    let binding = custody.state.bindings[0].binding_id.clone();
    ports.fail = Some("stop".into());
    assert_eq!(
        custody.revoke(&mut ports, &binding),
        Err(IvyErrorCode::Uncertain)
    );
    assert!(!ports.calls.iter().any(|m| m.ends_with(".finish")));
    ports.fail = None;
    custody.revoke(&mut ports, &binding).unwrap();
    assert_eq!(ports.stopped.len(), 2);
    assert!(
        custody
            .state
            .intents
            .iter()
            .all(|i| i.phase == Phase::Finished)
    );
    // Aggregate active/false/false finish ACKs do not resurrect denied consent.
    assert!(custody.state.denied.contains(&binding));
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn lost_begin_ack_never_applies_or_retries_and_new_transport_cannot_finish() {
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    ports.fail = Some("stellar.background.effect.begin".into());
    let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        custody.deliver(&mut ports, &staged, IvyLifecycleKind::Speech),
        Err(IvyErrorCode::Timeout)
    );
    assert!(ports.applied.is_empty());
    ports.fail = None;
    assert_eq!(
        custody.deliver(&mut ports, &staged, IvyLifecycleKind::Speech),
        Err(IvyErrorCode::Uncertain)
    );
    let op = custody.state.intents[0].operation.clone();
    drop(custody);
    ports.transport = "b".repeat(32);
    let mut custody =
        LifecycleCustody::open(ports.path.clone(), "session", &ports.transport).unwrap();
    let before = ports.calls.len();
    assert_eq!(
        custody.relinquish(&mut ports, &op),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(custody.refresh(&mut ports), Err(IvyErrorCode::Uncertain));
    assert_eq!(ports.calls.len(), before);
    assert_eq!(ports.stopped.len(), 1);
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn denial_between_begin_and_apply_stops_before_finish_and_never_publishes() {
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    ports.deny_after_begin = true;
    let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        custody.deliver(&mut ports, &staged, IvyLifecycleKind::Render),
        Err(IvyErrorCode::Protocol)
    );
    assert!(ports.applied.is_empty());
    assert_eq!(ports.stopped.len(), 1);
    assert!(custody.state.intents[0].phase == Phase::Finished);
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn unknown_begin_result_is_not_execution_authority_and_finish_ack_loss_does_not_reapply() {
    for status in ["unknown", "finished"] {
        let (mut custody, mut ports, directory) = fixture();
        custody.consent(&mut ports).unwrap();
        ports.begin = json!({"status":status,"execute":false});
        let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            custody.deliver(&mut ports, &staged, IvyLifecycleKind::Render),
            Err(IvyErrorCode::Uncertain)
        );
        assert!(ports.applied.is_empty());
        assert!(custody.state.intents[0].phase == Phase::Finished);
        if status == "unknown" {
            assert_eq!(ports.stopped.len(), 1);
            assert_eq!(
                ports.calls.iter().filter(|m| m.ends_with(".begin")).count(),
                1
            );
            assert_eq!(
                ports
                    .calls
                    .iter()
                    .filter(|m| m.ends_with(".finish"))
                    .count(),
                1
            );
        } else {
            assert!(ports.stopped.is_empty());
        }
        drop(custody);
        std::fs::remove_dir_all(directory).unwrap();
    }
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    custody
        .deliver(&mut ports, &staged, IvyLifecycleKind::Render)
        .unwrap();
    let op = custody.state.intents[0].operation.clone();
    ports.fail = Some("stellar.background.effect.finish".into());
    assert_eq!(
        custody.relinquish(&mut ports, &op),
        Err(IvyErrorCode::Timeout)
    );
    assert!(custody.state.intents[0].phase == Phase::Stopped);
    assert_eq!(
        custody.deliver(&mut ports, &staged, IvyLifecycleKind::Render),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(ports.applied.len(), 1);
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn wrong_origin_conflicting_receipt_corrupt_journal_and_second_owner_fail_closed() {
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    assert!(matches!(
        LifecycleCustody::open(ports.path.clone(), "session", &ports.transport),
        Err(IvyErrorCode::Busy)
    ));
    let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let previous = std::fs::read(custody.staging_path()).unwrap();
    for pointer in [
        "/entries/0/descriptor/origin/physicalTarget",
        "/entries/0/receipt/admission_id",
    ] {
        let mut changed: Value = serde_json::from_slice(&previous).unwrap();
        *changed.pointer_mut(pointer).unwrap() = json!("forged");
        std::fs::write(
            custody.staging_path(),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(
            custody
                .deliver(&mut ports, &staged, IvyLifecycleKind::Render)
                .is_err()
        );
    }
    assert!(ports.applied.is_empty());
    std::fs::write(custody.staging_path(), previous).unwrap();
    drop(custody);
    std::fs::write(&ports.path, b"{}").unwrap();
    assert!(matches!(
        LifecycleCustody::open(ports.path.clone(), "session", &ports.transport),
        Err(IvyErrorCode::Storage)
    ));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn poisoned_storage_still_cancels_every_local_resource_without_false_remote_finish() {
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    custody
        .deliver(&mut ports, &staged, IvyLifecycleKind::Render)
        .unwrap();
    // Inject a real atomic-write failure before a second effect can begin.
    std::fs::create_dir(ports.path.with_extension("pending")).unwrap();
    assert_eq!(
        custody.deliver(&mut ports, &staged, IvyLifecycleKind::Speech),
        Err(IvyErrorCode::Storage)
    );
    let before = ports.calls.len();
    assert_eq!(custody.refresh(&mut ports), Err(IvyErrorCode::Uncertain));
    let binding = custody.state.bindings[0].binding_id.clone();
    assert_eq!(
        custody.revoke(&mut ports, &binding),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(ports.calls.len(), before);
    assert_eq!(ports.applied.len(), 1);
    assert_eq!(ports.stopped.len(), 2); // includes absent queued speech fence
    let retained = LifecycleCustody::read(&ports.path, "session").unwrap();
    assert_eq!(retained.intents.len(), 1);
    assert!(retained.intents[0].phase == Phase::Claimed); // durable uncertainty retained
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn denied_or_unavailable_inspection_stops_held_effects_and_never_restores_permission() {
    for unavailable in [false, true] {
        let (mut custody, mut ports, directory) = fixture();
        custody.consent(&mut ports).unwrap();
        let staged = ports.fixture["inspection"]["receipt"]["admission_id"]
            .as_str()
            .unwrap()
            .to_owned();
        custody
            .deliver(&mut ports, &staged, IvyLifecycleKind::Render)
            .unwrap();
        if unavailable {
            ports.fail = Some("stellar.background.inspect".into());
        } else {
            ports.fixture["now"] = json!(ports.fixture["now"].as_u64().unwrap() + 300001);
        }
        custody.refresh(&mut ports).unwrap();
        assert_eq!(ports.stopped.len(), 1);
        assert!(custody.state.intents[0].phase == Phase::Finished);
        ports.fail = None;
        ports.fixture["now"] = json!(1700000000000u64);
        assert_eq!(
            custody.deliver(&mut ports, &staged, IvyLifecycleKind::Speech),
            Err(IvyErrorCode::Protocol)
        );
        assert_eq!(ports.applied.len(), 1);
        drop(custody);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn sticky_staging_denial_stops_active_custody_despite_a_later_authorized_host_response() {
    let (mut custody, mut ports, directory) = fixture();
    custody.consent(&mut ports).unwrap();
    let admission = ports.fixture["inspection"]["receipt"]["admission_id"]
        .as_str()
        .unwrap()
        .to_owned();
    custody
        .deliver(&mut ports, &admission, IvyLifecycleKind::Render)
        .unwrap();
    let mut staged =
        super::lifecycle_store::Staging::load(&custody.staging_path(), "session").unwrap();
    staged.entries[0].withheld = true;
    staged.entries[0].receipt.result = None;
    staged.save(&custody.staging_path()).unwrap();
    custody.refresh(&mut ports).unwrap();
    assert_eq!(ports.applied.len(), 1);
    assert_eq!(ports.stopped.len(), 1);
    assert!(custody.state.intents[0].phase == Phase::Finished);
    assert!(
        custody
            .deliver(&mut ports, &admission, IvyLifecycleKind::Speech)
            .is_err()
    );
    drop(custody);
    std::fs::remove_dir_all(directory).unwrap();
}
