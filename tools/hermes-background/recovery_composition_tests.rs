#![cfg(windows)]
use super::{contracts::*, replay_recovery_tests::*, update_store::Updates};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn capture(missed: bool) -> Value {
    let directory = PathBuf::from(std::env::var("STELLAR_RECOVERY_COMPOSITION").unwrap());
    let name = if missed {
        "consumer-recovery-missed.json"
    } else {
        "consumer-recovery-retained.json"
    };
    serde_json::from_slice(&fs::read(directory.join(name)).unwrap()).unwrap()
}

#[test]
fn fresh_composed_host_recovers_retained_revoked_notice_and_unknown_without_resend() {
    let data = capture(false);
    for revoked in [false, true] {
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
        assert!(!after.recovery_pending);
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
        for forbidden in ["prompt.submit", "session.new", "prompt.receipt"] {
            assert!(!calls.contains(forbidden));
        }
        cleanup(session, source, dir);
    }
}

#[test]
fn fresh_composed_host_recovers_missed_terminal_and_speech_dispatch_claim_once() {
    let data = capture(true);
    let (source, owner) = seed(&data, false);
    let (mut session, dir) = reopen(&source, &data, false);
    let unknown = fs::read(dir.join("copied/ivy-session.json")).unwrap();
    session
        .resume_updates(&data["resume_after_restart"]["result"])
        .unwrap();
    let updates = session
        .shared
        .view
        .lock()
        .unwrap()
        .snapshot
        .background_updates
        .clone()
        .unwrap();
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
    for completion in &retained.completed {
        assert_eq!(
            completion.speech_claim.as_deref(),
            Some(if completion.id == id {
                "00000000-0000-0000-0000-000000000089"
            } else {
                "00000000-0000-0000-0000-000000000088"
            })
        );
    }
    assert_eq!(
        unknown,
        fs::read(dir.join("copied/ivy-session.json")).unwrap()
    );
    cleanup(session, source, dir);
}

#[test]
fn fresh_composed_capture_with_unsupported_inspection_hides_retained_notices_without_state_loss() {
    let data = capture(false);
    let (source, owner) = seed(&data, false);
    let (mut session, dir) = reopen(&source, &data, true);
    let unknown = fs::read(dir.join("copied/ivy-session.json")).unwrap();
    let prior = Updates::load(&session.journal.updates_path(), &owner).unwrap();
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
