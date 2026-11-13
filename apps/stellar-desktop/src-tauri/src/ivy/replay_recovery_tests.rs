#![cfg(windows)]
use super::{
    contracts::*, journal::Journal, process::Broker, recovery_tests::fixture, session::Session,
    update_store::Updates,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub(super) fn capture(missed: bool) -> Value {
    serde_json::from_str(if missed {
        include_str!("../../../../../tools/native/evidence/recovery-missed-v1.json")
    } else {
        include_str!("../../../../../tools/native/evidence/recovery-retained-v1.json")
    })
    .unwrap()
}
pub(super) fn event(data: &Value, key: &str) -> Value {
    let mut p = data[key]["params"].clone();
    if p["type"] == "message.start" {
        p["payload"] = json!({"plugin_notification":p["payload"]["plugin_notification"]});
    }
    json!({"event":"gateway","data":{"params":p}})
}
pub(super) fn seed(data: &Value, revoked: bool) -> (PathBuf, String) {
    let reply = format!(
        "'{}' | ConvertFrom-Json",
        data["producer_inspection_rpc"]["result"]
            .to_string()
            .replace('\'', "''")
    );
    let (mut session, directory) = fixture(&reply);
    let owner = data["binding"]["owner_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    session.record.session_id = Some(owner.clone());
    session.event(event(data, "raw_start")).unwrap();
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
        session.event(event(data, "raw_revoke")).unwrap();
    }
    session.record.input_id = Some("00000000-0000-0000-0000-000000000099".into());
    session.record.admission_id = None;
    session.record.generation = None;
    session.record.unsettled = true;
    session.journal.save(&session.record).unwrap();
    drop(session);
    (directory, owner)
}
pub(super) fn reopen(source: &Path, data: &Value, unsupported: bool) -> (Session, PathBuf) {
    let (initial, dir) = fixture("@{}");
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
    let copy = dir.join("copied");
    fs::create_dir(&copy).unwrap();
    for file in ["ivy-session.json", "ivy-updates.json"] {
        fs::copy(source.join(file), copy.join(file)).unwrap();
    }
    let (journal, record) = Journal::open(&copy).unwrap();
    let path = dir.join("frames.json");
    fs::write(&path, serde_json::to_vec(data).unwrap()).unwrap();
    let script = format!(
        r#"
$d=Get-Content -LiteralPath '{}' -Raw | ConvertFrom-Json
while ($line=[Console]::ReadLine()) {{
 $r=$line|ConvertFrom-Json
 [IO.File]::AppendAllText('{}',$r.method+"`n")
 if ($r.method -eq 'stellar.notification.inspect' -and ${unsupported}) {{
  $frame=@{{id=$r.id;error=@{{code='unavailable'}}}}
 }} else {{
  $result=switch($r.method) {{
   'stellar.session.recover' {{ $d.recovery_rpc }}
   'session.events.since' {{ if ($r.params.replay_epoch -eq $d.old_epoch) {{$d.replay_after_restart.result}} else {{$d.recovery_rpc.tail}} }}
   'stellar.notification.inspect' {{ $d.recovered_inspections.PSObject.Properties[$r.params.admission_id].Value }}
   default {{ exit 17 }}
  }}
  $frame=@{{id=$r.id;result=$result}}
 }}
 [Console]::WriteLine(($frame|ConvertTo-Json -Depth 40 -Compress))
}}
"#,
        path.to_string_lossy().replace('\'', "''"),
        dir.join("calls.txt").to_string_lossy().replace('\'', "''"),
        unsupported = if unsupported { "true" } else { "false" }
    );
    let script_path = dir.join("broker.ps1");
    fs::write(&script_path, script).unwrap();
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(script_path)
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
        dir,
    )
}
pub(super) fn cleanup(session: Session, source: PathBuf, dir: PathBuf) {
    drop(session);
    fs::remove_dir_all(source).unwrap();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn actual_retained_restart_recovers_cursor_preserving_unknown_notice_and_spoken_claim() {
    for revoked in [false, true] {
        let data = capture(false);
        let (source, owner) = seed(&data, revoked);
        let (mut session, dir) = reopen(&source, &data, false);
        let unknown = fs::read(dir.join("copied/ivy-session.json")).unwrap();
        let prior = Updates::load(&session.journal.updates_path(), &owner).unwrap();
        session
            .resume_updates(&data["resume_after_restart"]["result"])
            .unwrap();
        let after = Updates::load(&session.journal.updates_path(), &owner).unwrap();
        assert_eq!(prior.completed, after.completed);
        assert!(prior.notices == after.notices);
        assert_eq!(
            after.cursor.as_ref().unwrap().0,
            data["recovery_rpc"]["snapshot"]["replay_epoch"]
        );
        assert_eq!(
            unknown,
            fs::read(dir.join("copied/ivy-session.json")).unwrap()
        );
        assert!(session.record.unsettled && session.record.admission_id.is_none());
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
        let calls = fs::read_to_string(dir.join("calls.txt")).unwrap();
        assert!(
            !calls.contains("prompt.submit")
                && !calls.contains("session.new")
                && !calls.contains("prompt.receipt")
        );
        cleanup(session, source, dir);
    }
}

#[test]
fn actual_missed_terminal_is_recovered_once_without_replaying_retained_speech() {
    let data = capture(true);
    let (source, owner) = seed(&data, false);
    let (mut session, dir) = reopen(&source, &data, false);
    let unknown = fs::read(dir.join("copied/ivy-session.json")).unwrap();
    session
        .resume_updates(&data["resume_after_restart"]["result"])
        .unwrap();
    let snapshot = session.shared.view.lock().unwrap().snapshot.clone();
    let updates = snapshot.background_updates.unwrap();
    assert_eq!(updates.len(), 1);
    let id = updates[0].id.clone();
    assert_ne!(id, data["raw_start"]["params"]["admission_id"]);
    assert!(updates[0].speech_claim.is_none());
    session
        .claim_update(IvyClaimUpdateRequest {
            version: 1,
            update_id: id.clone(),
            request_id: "00000000-0000-0000-0000-000000000089".into(),
        })
        .unwrap();
    session
        .resume_updates(&data["resume_after_restart"]["result"])
        .unwrap();
    let retained = Updates::load(&session.journal.updates_path(), &owner).unwrap();
    assert_eq!(retained.completed.len(), 2);
    assert_eq!(
        retained
            .completed
            .iter()
            .find(|u| u.id == id)
            .unwrap()
            .speech_claim
            .as_deref(),
        Some("00000000-0000-0000-0000-000000000089")
    );
    assert_eq!(
        retained
            .completed
            .iter()
            .find(|u| u.id != id)
            .unwrap()
            .speech_claim
            .as_deref(),
        Some("00000000-0000-0000-0000-000000000088")
    );
    assert_eq!(
        unknown,
        fs::read(dir.join("copied/ivy-session.json")).unwrap()
    );
    cleanup(session, source, dir);
}

#[test]
fn unsupported_original_host_hides_notices_and_preserves_custody_and_unknown() {
    let data = capture(false);
    let (source, owner) = seed(&data, false);
    let (mut session, dir) = reopen(&source, &data, true);
    let prior = Updates::load(&session.journal.updates_path(), &owner).unwrap();
    let unknown = fs::read(dir.join("copied/ivy-session.json")).unwrap();
    session
        .resume_updates(&data["resume_after_restart"]["result"])
        .unwrap();
    let after = Updates::load(&session.journal.updates_path(), &owner).unwrap();
    assert_eq!(prior.completed, after.completed);
    assert!(prior.notices == after.notices);
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
    assert_eq!(
        session
            .claim_update(IvyClaimUpdateRequest {
                version: 1,
                update_id: prior.completed[0].id.clone(),
                request_id: "00000000-0000-0000-0000-000000000089".into()
            })
            .unwrap_err(),
        IvyErrorCode::Unavailable
    );
    assert_eq!(
        unknown,
        fs::read(dir.join("copied/ivy-session.json")).unwrap()
    );
    cleanup(session, source, dir);
}

#[test]
fn incomplete_inventory_or_repeated_gap_cannot_replace_cursor_or_show_retained_output() {
    for defect in ["missing", "epoch", "receipt", "gap"] {
        let mut data = capture(false);
        let (source, owner) = seed(&data, false);
        match defect {
            "missing" => data["recovery_rpc"]["entries"] = json!([]),
            "epoch" => data["recovery_rpc"]["tail"]["replay_epoch"] = json!("foreign"),
            "receipt" => {
                data["recovery_rpc"]["entries"][0]["receipt"]["execution_generation"] = json!(999)
            }
            _ => data["recovery_rpc"]["tail"]["truncated"] = json!(true),
        }
        let (mut session, dir) = reopen(&source, &data, false);
        let before = fs::read(session.journal.updates_path()).unwrap();
        assert!(
            session
                .resume_updates(&data["resume_after_restart"]["result"])
                .is_err()
        );
        assert_eq!(before, fs::read(session.journal.updates_path()).unwrap());
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
        assert_eq!(
            Updates::load(&session.journal.updates_path(), &owner)
                .unwrap()
                .completed
                .len(),
            1
        );
        cleanup(session, source, dir);
    }
}
