#![cfg(windows)]
use super::{contracts::IvyErrorCode, process::Broker, session_tests::fixture};
use serde_json::{Value, json};
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../tools/native/fixtures/lifecycle-v1.json"
    ))
    .unwrap()
}

#[test]
fn native_stages_exact_inspection_without_legacy_output_or_prompt_submission() {
    let g = golden();
    let bindings = json!({"bindings":[g["binding"].clone()]})
        .to_string()
        .replace('\'', "''");
    let inspection = g["inspection"].to_string().replace('\'', "''");
    let contract_hash = super::lifecycle_contract::CONTRACT_SHA256;
    let script = format!(
        r#"
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
while ($line=[Console]::ReadLine()) {{
 $r=$line|ConvertFrom-Json
 $value=switch($r.method) {{
  'runtime.describe' {{ @{{profile='ivy';protocol=1;capabilities=@('stellar.background.v1');background_v1_contract_sha256='{contract_hash}'}} }}
  'session.background.bindings' {{ '{bindings}'|ConvertFrom-Json }}
  'session.background.inspect' {{ '{inspection}'|ConvertFrom-Json }}
  default {{ exit 17 }}
 }}
 [Console]::WriteLine((@{{id=$r.id;result=$value}}|ConvertTo-Json -Depth 20 -Compress))
}}
"#
    );
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let (mut session, directory) = fixture();
    session.broker = Some(Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap());
    let card = g["inspection"]["descriptor"].clone();
    let event = json!({"event":"gateway","data":{"params":{
        "session_id":"session","admission_id":"lifecycle-admission","authority_epoch":2,
        "execution_generation":7,"seq":1,"replay_epoch":"epoch","type":"message.start",
        "payload":{"background_v1":card}
    }}});
    assert_eq!(session.event(event.clone()), Err(IvyErrorCode::Protocol));
    session.call("runtime.describe", json!({})).unwrap();
    session.event(event.clone()).unwrap();
    let files = std::fs::read_dir(&directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ivy-lifecycle-")
        })
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    let stored = std::fs::read(&files[0]).unwrap();
    session.event(event).unwrap();
    assert_eq!(std::fs::read(&files[0]).unwrap(), stored);
    session.resume_lifecycle().unwrap();
    assert_eq!(std::fs::read(&files[0]).unwrap(), stored);
    let legacy_path = session.journal.updates_path();
    let legacy_before = std::fs::read(&legacy_path).unwrap();
    let downgrade = json!({"event":"gateway","data":{"params":{
        "session_id":"session","admission_id":"lifecycle-admission","authority_epoch":2,
        "execution_generation":7,"seq":2,"replay_epoch":"epoch","type":"message.start",
        "payload":{"autonomous":true}
    }}});
    assert_eq!(session.event(downgrade), Err(IvyErrorCode::Protocol));
    assert_eq!(std::fs::read(&legacy_path).unwrap(), legacy_before);
    assert_eq!(std::fs::read(&files[0]).unwrap(), stored);
    // The inert broker would exit on any legacy prompt.receipt fallback.
    session.call("runtime.describe", json!({})).unwrap();
    let mut legacy = super::update_store::Updates::load(&legacy_path, "session").unwrap();
    legacy
        .completed
        .push(super::contracts::IvyBackgroundUpdate {
            id: "lifecycle-admission".into(),
            text: "Legacy custody".into(),
            speech_claim: None,
        });
    legacy.save(&legacy_path).unwrap();
    let mixed = json!({"event":"gateway","data":{"params":{
        "session_id":"session","admission_id":"lifecycle-admission","authority_epoch":2,
        "execution_generation":7,"seq":2,"replay_epoch":"epoch","type":"message.complete",
        "payload":{"background_v1":card}
    }}});
    assert_eq!(session.event(mixed), Err(IvyErrorCode::Protocol));
    assert_eq!(std::fs::read(&files[0]).unwrap(), stored);
    let state: Value = serde_json::from_slice(&stored).unwrap();
    assert_eq!(state["entries"][0]["descriptor"], card);
    assert_eq!(state["entries"][0]["withheld"], true); // golden grant is deliberately expired in real time
    assert!(state["entries"][0]["receipt"].get("result").is_none());
    assert!(
        session
            .shared
            .view
            .lock()
            .unwrap()
            .snapshot
            .background_updates
            .is_none()
    );
    assert!(session.record.unsettled);
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reconnect_persists_known_revocation_before_unknown_or_a_later_failed_read() {
    use super::{
        lifecycle_contract::Binding, lifecycle_receipt::Inspection, lifecycle_store::Staging,
    };
    use sha2::{Digest, Sha256};
    for all_unknown in [false, true] {
        let mut g = golden();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        g["binding"]["createdAt"] = json!(now - 1000);
        g["binding"]["expiresAt"] = json!(now + 600000);
        g["inspection"]["descriptor"]["expiresAt"] = json!(now + 600000);
        g["inspection"]["descriptor"]["eventExpiresAt"] = json!(now + 300000);
        let b1: Binding = serde_json::from_value(g["binding"].clone()).unwrap();
        let i1: Inspection = serde_json::from_value(g["inspection"].clone()).unwrap();
        let mut b2 = b1.clone();
        b2.binding_id = "2".repeat(32);
        let mut i2 = i1.clone();
        i2.descriptor.as_mut().unwrap().binding_id = b2.binding_id.clone();
        i2.descriptor.as_mut().unwrap().event_id = "other".into();
        i2.receipt.as_mut().unwrap().admission_id = "other".into();
        i2.receipt.as_mut().unwrap().sequence = 5;
        let mut stage = Staging {
            session: "session".into(),
            ..Staging::default()
        };
        stage.observe(&b1, i1.clone(), "epoch", 1, now).unwrap();
        stage.observe(&b2, i2, "epoch", 2, now).unwrap();
        let mut revoked = b1;
        revoked.revoked = true;
        let bindings = json!({"bindings":[revoked,b2]})
            .to_string()
            .replace('\'', "''");
        let unknown = json!({"schemaVersion":1,"status":"unknown","retryAuthorized":false});
        let mut denied = i1.clone();
        denied.delivery_authorized = Some(false);
        let responses = json!({i1.descriptor.as_ref().unwrap().event_id.clone():
            if all_unknown {unknown.clone()} else {serde_json::to_value(denied).unwrap()},"other":unknown})
            .to_string().replace('\'',"''");
        let pin = super::lifecycle_contract::CONTRACT_SHA256;
        let script = format!(
            r#"
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$answers='{responses}'|ConvertFrom-Json
while($line=[Console]::ReadLine()) {{
 $r=$line|ConvertFrom-Json
 $v=switch($r.method) {{
  'runtime.describe' {{ @{{profile='ivy';protocol=1;capabilities=@('stellar.background.v1');background_v1_contract_sha256='{pin}'}} }}
  'session.background.bindings' {{ '{bindings}'|ConvertFrom-Json }}
  'session.background.inspect' {{ $answers.PSObject.Properties[$r.params.event_id].Value }}
  default {{ exit 17 }}
 }}
 [Console]::WriteLine((@{{id=$r.id;result=$v}}|ConvertTo-Json -Depth 20 -Compress))
}}
"#
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        let (mut session, directory) = fixture();
        session.broker = Some(Broker::spawn(command, Arc::new(Mutex::new(None))).unwrap());
        session.call("runtime.describe", json!({})).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"session"));
        let path = session
            .journal
            .updates_path()
            .with_file_name(format!("ivy-lifecycle-{hash}.json"));
        stage.save(&path).unwrap();
        assert_eq!(session.resume_lifecycle(), Err(IvyErrorCode::Uncertain));
        let saved = Staging::load(&path, "session").unwrap();
        assert!(saved.entries[0].withheld && saved.entries[0].receipt.result.is_none());
        assert!(!saved.entries[1].withheld && saved.entries[1].receipt.result.is_some());
        assert_eq!(saved.cursor, Some(("epoch".into(), 2)));
        assert!(session.record.unsettled);
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
