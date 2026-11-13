#![cfg(windows)]
use super::{contracts::*, recovery_tests::fixture, update_store::Updates};
use serde_json::{Value, json};

fn start(id: u64, epoch: &str) -> Value {
    json!({"event":"gateway","data":{"params":{
        "session_id":"session","admission_id":id.to_string(),"authority_epoch":2,"execution_generation":7,
        "seq":id,"replay_epoch":epoch,"type":"message.start","payload":{"autonomous":true}
    }}})
}

#[test]
fn nested_receipt_events_drain_in_order_before_any_newer_event() {
    let receipt = r#"
$id = [int]$request.params.admission_id
if ($id -lt 4 -and -not $script:sent.ContainsKey($id)) {
  if ($null -eq $script:sent) { $script:sent = @{} }
  $script:sent[$id] = $true
  $next = $id + 1
  [Console]::WriteLine((@{event='gateway';data=@{params=@{
    session_id='session';admission_id=[string]$next;authority_epoch=2;execution_generation=7;
    seq=$next;replay_epoch='replay';type='message.start';payload=@{autonomous=$true}
  }}} | ConvertTo-Json -Compress -Depth 8))
}
@{ref=@{session_id='session'};admission_id=[string]$id;authority_epoch=2;execution_generation=7;
sequence=$id;status='terminal';outcome='completed';result=@{final_response="Answer $id"}}
"#;
    let receipt = receipt.replace(
        "if ($id -lt 4 -and",
        "if ($null -eq $script:sent) { $script:sent = @{} }; if ($id -lt 4 -and",
    );
    let (mut session, directory) = fixture(&receipt);
    session.buffered.push(start(1, "replay"));
    session.drain().unwrap();
    assert!(session.buffered.is_empty());
    let updates = Updates::load(&session.journal.updates_path(), "session").unwrap();
    assert_eq!(
        updates
            .completed
            .iter()
            .map(|u| u.id.as_str())
            .collect::<Vec<_>>(),
        ["1", "2", "3", "4"]
    );
    assert_eq!(updates.cursor, Some(("replay".into(), 4)));
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn changed_replay_epoch_cannot_publish_or_persist_an_update() {
    let receipt = "@{ref=@{session_id='session'};admission_id='2';authority_epoch=2;execution_generation=7;sequence=2;status='terminal';outcome='completed';result=@{final_response='Rejected'}}";
    let (mut session, directory) = fixture(receipt);
    let path = session.journal.updates_path();
    Updates {
        session: "session".into(),
        cursor: Some(("replay".into(), 1)),
        ..Updates::default()
    }
    .save(&path)
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        session.event(start(2, "foreign")),
        Err(IvyErrorCode::Uncertain)
    );
    assert_eq!(std::fs::read(path).unwrap(), before);
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
    drop(session);
    std::fs::remove_dir_all(directory).unwrap();
}
