#![cfg(windows)]
use super::{
    contracts::*, journal::Journal, process::Broker, recovery_tests::fixture, session::Session,
    update_store::Updates,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
};

fn captured() -> Value {
    serde_json::from_slice(&fs::read(std::env::var("STELLAR_RECOVERY_CAPTURE").unwrap()).unwrap())
        .unwrap()
}
fn reply(value: &Value) -> String {
    format!(
        "'{}' | ConvertFrom-Json",
        serde_json::to_string(value).unwrap().replace('\'', "''")
    )
}
fn projected(frame: &Value) -> Value {
    let mut params = frame["params"].clone();
    if params["type"] == "message.start" {
        params["payload"] = json!({"plugin_notification":params["payload"]["plugin_notification"]});
    }
    json!({"event":"gateway","data":{"params":params}})
}
fn seed(data: &Value, revoked: bool) -> (PathBuf, String) {
    let (mut session, directory) = fixture(&reply(&data["producer_inspection_rpc"]["result"]));
    let owner = data["binding"]["owner_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    session.record.session_id = Some(owner.clone());
    session.event(projected(&data["raw_start"])).unwrap();
    session
        .claim_update(IvyClaimUpdateRequest {
            version: 1,
            update_id: data["raw_start"]["params"]["admission_id"]
                .as_str()
                .unwrap()
                .into(),
            request_id: "00000000-0000-0000-0000-000000000088".into(),
        })
        .unwrap();
    if revoked {
        session.event(projected(&data["raw_revoke"])).unwrap();
    }
    // A later foreground submit lost its ACK: fixture-only UNKNOWN, never the real299 journal.
    session.record.input_id = Some("00000000-0000-0000-0000-000000000099".into());
    session.record.admission_id = None;
    session.record.generation = None;
    session.record.unsettled = true;
    session.journal.save(&session.record).unwrap();
    drop(session);
    (directory, owner)
}
fn reopen_copy(source: &std::path::Path, data: &Value, original_host: bool) -> (Session, PathBuf) {
    let (initial, directory) = fixture("@{}");
    let Session {
        journal,
        broker,
        shared,
        epoch,
        workspace_epoch,
        buffered,
        replay,
        ..
    } = initial;
    drop(journal);
    drop(broker);
    let target = directory.join("copied");
    fs::create_dir(&target).unwrap();
    for name in ["ivy-session.json", "ivy-updates.json"] {
        fs::copy(source.join(name), target.join(name)).unwrap();
    }
    let (journal, record) = Journal::open(&target).unwrap();
    let calls = directory.join("calls.txt");
    let inspect = if original_host {
        "$null".into()
    } else {
        reply(&data["recovered_inspection_rpc"]["result"])
    };
    let host_replay = data["replay_after_restart"].get("result").unwrap();
    assert_eq!(host_replay["truncated"], true);
    assert_eq!(host_replay["snapshot_required"], true);
    assert_ne!(host_replay["replay_epoch"], data["old_epoch"]);
    let replay_result = reply(host_replay);
    let script = format!(
        r#"
while ($line = [Console]::ReadLine()) {{
 $request = $line | ConvertFrom-Json
 [IO.File]::AppendAllText('{}', $request.method + "`n")
 $result = if ($request.method -eq 'stellar.notification.inspect') {{ {inspect} }} elseif ($request.method -eq 'session.events.since') {{ {replay_result} }} else {{ exit 7 }}
 $frame = if ($null -eq $result) {{ @{{id=$request.id;error=@{{code='unavailable'}}}} }} else {{ @{{id=$request.id;result=$result}} }}
 [Console]::WriteLine(($frame | ConvertTo-Json -Compress -Depth 30))
}}
"#,
        calls.to_string_lossy().replace('\'', "''")
    );
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let broker = Broker::spawn(command, std::sync::Arc::new(std::sync::Mutex::new(None))).unwrap();
    (
        Session {
            journal,
            record,
            broker: Some(broker),
            shared,
            epoch,
            workspace_epoch,
            buffered,
            replay,
        },
        directory,
    )
}
fn qualify(revoked: bool, original_host: bool, expected: IvyErrorCode) {
    let data = captured();
    let (source, owner) = seed(&data, revoked);
    let (mut session, directory) = reopen_copy(&source, &data, original_host);
    let record_path = session
        .journal
        .updates_path()
        .with_file_name("ivy-session.json");
    let foreground = fs::read(&record_path).unwrap();
    let notice_bytes = fs::read(session.journal.updates_path()).unwrap();
    let retained = Updates::load(&session.journal.updates_path(), &owner).unwrap();
    assert_eq!(retained.completed.len(), 1);
    assert_eq!(retained.notices.len(), 1);
    assert_eq!(
        retained.completed[0].speech_claim.as_deref(),
        Some("00000000-0000-0000-0000-000000000088")
    );
    let resumed = &data["resume_after_restart"]["result"];
    assert_eq!(session.resume_updates(resumed), Err(expected));
    assert!(session.record.unsettled);
    assert!(session.record.admission_id.is_none());
    assert_eq!(foreground, fs::read(&record_path).unwrap());
    assert_eq!(
        notice_bytes,
        fs::read(session.journal.updates_path()).unwrap()
    );
    let calls = fs::read_to_string(directory.join("calls.txt")).unwrap();
    assert!(!calls.contains("prompt.submit"));
    assert!(!calls.contains("session.new"));
    assert!(!calls.contains("prompt.receipt"));
    if revoked {
        assert!(!calls.contains("stellar.notification.inspect"));
    }
    drop(session);
    assert!(
        Journal::open(&directory.join("copied"))
            .unwrap()
            .1
            .unsettled
    );
    fs::remove_dir_all(source).unwrap();
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn original_host_refuses_unrevoked_retained_notice_without_losing_unknown_or_speech_claim() {
    qualify(false, true, IvyErrorCode::Unavailable);
}
#[test]
fn actual_fresh_candidate_replay_gap_refuses_retained_notice_without_rewriting_state() {
    qualify(false, false, IvyErrorCode::Uncertain);
}
#[test]
fn authenticated_revocation_does_not_bypass_real_fresh_host_replay_gap() {
    qualify(true, false, IvyErrorCode::Uncertain);
}
