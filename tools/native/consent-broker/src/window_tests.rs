use super::*;
use std::sync::atomic::AtomicBool;

// Test-only associations: no HWND, OS verification, canonical ticket or receipt.
fn fixture() -> Attachment {
    let mut scope = crate::tests::scope(1, 1);
    scope.challenge_expires_at -= 1_000;
    Attachment {
        identity: [1; 32],
        policy: [2; 32],
        generation: 1,
        scope,
        alive: true,
        token: Arc::new(()),
        flow_claimed: AtomicBool::new(false),
    }
}
fn intent(a: &Attachment) -> GrantIntent {
    GrantIntent {
        attachment: a.identity,
        generation: a.generation,
        digest: digest(&a.scope, &a.policy, a.generation).unwrap(),
        challenge: a.scope.challenge_id.clone(),
        token: Arc::clone(&a.token),
    }
}
fn success(a: &Attachment) -> HostConsumeSuccess {
    HostConsumeSuccess {
        attachment: a.identity,
        generation: a.generation,
        digest: digest(&a.scope, &a.policy, a.generation).unwrap(),
        challenge: a.scope.challenge_id.clone(),
        token: Arc::clone(&a.token),
    }
}
fn reserve(flow: &mut WindowFlow, a: &Attachment) {
    flow.begin(a, 1).unwrap();
    flow.callback_consumed(a, 1, &intent(a)).unwrap();
    flow.reserve_host_effect(a, 1).unwrap();
}

#[test]
fn known_host_success_authorizes_only_intentional_same_generation_close() {
    let a = fixture();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    assert_eq!(
        flow.host_succeeded(&a, 1, success(&a)),
        Err(Error::ApprovalRequired)
    );
    reserve(&mut flow, &a);
    assert_eq!(flow.phase(), WindowPhase::HostUncertain);
    flow.host_succeeded(&a, 1, success(&a)).unwrap();
    assert_eq!(flow.phase(), WindowPhase::RetirementAuthorized);
    flow.window_destroyed(&a, 1).unwrap();
    assert_eq!(flow.phase(), WindowPhase::Closed);
    flow.window_destroyed(&a, 1).unwrap();
    assert_eq!(flow.begin(&a, 1), Err(Error::ChallengeConsumed));
    assert_eq!(
        flow.host_succeeded(&a, 1, success(&a)),
        Err(Error::ChallengeConsumed)
    );
    assert!(flow.host_effect_reserved());
    assert_eq!(flow.cancel(), Err(Error::Uncertain));
    assert_eq!(flow.phase(), WindowPhase::Denied(Error::Uncertain));
}

#[test]
fn premature_window_loss_never_retires_or_accepts_late_success() {
    for stage in 0..=3 {
        let a = fixture();
        let mut flow = WindowFlow::claim(&a, 1).unwrap();
        if stage >= 1 {
            flow.begin(&a, 1).unwrap();
        }
        if stage >= 2 {
            flow.callback_consumed(&a, 1, &intent(&a)).unwrap();
        }
        if stage >= 3 {
            flow.reserve_host_effect(&a, 1).unwrap();
        }
        let error = if stage == 3 {
            Error::Uncertain
        } else {
            Error::ChallengeCancelled
        };
        assert_eq!(flow.window_destroyed(&a, 1), Err(error));
        assert_eq!(flow.host_succeeded(&a, 1, success(&a)), Err(error));
        assert_eq!(flow.phase(), WindowPhase::Denied(error));
        assert_eq!(flow.host_effect_reserved(), stage == 3);
    }
}

#[test]
fn cancel_and_timeout_reserve_unknown_effects_without_replay() {
    let a = fixture();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    reserve(&mut flow, &a);
    assert_eq!(flow.reserve_host_effect(&a, 1), Err(Error::Uncertain));
    assert_eq!(flow.cancel(), Err(Error::Uncertain));
    assert_eq!(
        flow.host_succeeded(&a, 1, success(&a)),
        Err(Error::Uncertain)
    );
    assert!(flow.host_effect_reserved());
}

#[test]
fn wrong_window_or_callback_generation_sticks() {
    let a = fixture();
    assert!(matches!(
        WindowFlow::claim(&a, 0),
        Err(Error::InvalidRequest)
    ));
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    flow.begin(&a, 1).unwrap();
    assert_eq!(flow.begin(&a, 1), Err(Error::Busy));
    assert_eq!(
        flow.callback_consumed(&a, 2, &intent(&a)),
        Err(Error::ChallengeCancelled)
    );
    assert_eq!(
        flow.callback_consumed(&a, 1, &intent(&a)),
        Err(Error::ChallengeCancelled)
    );
}

#[test]
fn exact_attachment_lineage_refuses_identical_field_replacement() {
    let a = fixture();
    let mut b = fixture();
    b.scope = a.scope.clone();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    assert_eq!(flow.begin(&b, 1), Err(Error::TransportChanged));
    assert_eq!(flow.begin(&a, 1), Err(Error::TransportChanged));
    drop(flow);
    assert!(matches!(WindowFlow::claim(&a, 1), Err(Error::Uncertain)));
}

#[test]
fn claim_is_once_per_attachment_even_after_drop_or_invalidation() {
    let a = fixture();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    assert!(matches!(WindowFlow::claim(&a, 2), Err(Error::Uncertain)));
    flow.invalidate_attachment();
    drop(flow);
    assert!(matches!(WindowFlow::claim(&a, 2), Err(Error::Uncertain)));
}

#[test]
fn concurrent_claims_cannot_construct_replacement_window_registries() {
    let a = Arc::new(fixture());
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let a = Arc::clone(&a);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                WindowFlow::claim(&a, 1).map(|_| ())
            })
        })
        .collect();
    let outcomes: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|r| **r == Err(Error::Uncertain))
            .count(),
        1
    );
    assert!(matches!(WindowFlow::claim(&a, 1), Err(Error::Uncertain)));
}

#[test]
fn changed_profile_target_route_policy_lifetime_cannot_restore_flow() {
    for change in 0..5 {
        let mut a = fixture();
        let mut flow = WindowFlow::claim(&a, 1).unwrap();
        reserve(&mut flow, &a);
        let original_scope = a.scope.clone();
        let error = match change {
            0 => {
                a.scope.origin.physical_target = "compression-tip".into();
                Error::OriginChanged
            }
            1 => {
                a.scope.origin.profile_id = "other".into();
                Error::OriginChanged
            }
            2 => {
                a.scope.origin.route = "new-route".into();
                Error::OriginChanged
            }
            3 => {
                a.policy = [3; 32];
                Error::PolicyChanged
            }
            _ => {
                a.alive = false;
                Error::TransportChanged
            }
        };
        assert_eq!(flow.host_succeeded(&a, 1, success(&a)), Err(error));
        a.scope = original_scope;
        a.policy = [2; 32];
        a.alive = true;
        assert_eq!(flow.begin(&a, 1), Err(error));
        assert!(flow.host_effect_reserved());
    }
}

#[test]
fn mismatched_private_callback_and_host_reply_are_not_scope_proof() {
    let a = fixture();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    flow.begin(&a, 1).unwrap();
    let mut wrong = intent(&a);
    wrong.digest[0] ^= 1;
    assert_eq!(flow.callback_consumed(&a, 1, &wrong), Err(Error::Uncertain));
    let a = fixture();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    reserve(&mut flow, &a);
    let mut wrong = success(&a);
    wrong.token = Arc::new(());
    assert_eq!(flow.host_succeeded(&a, 1, wrong), Err(Error::Uncertain));
    assert_eq!(flow.phase(), WindowPhase::Denied(Error::Uncertain));
    assert!(flow.host_effect_reserved());
}

#[test]
fn monotonic_expiry_fences_delayed_private_host_success() {
    let a = fixture();
    let mut flow = WindowFlow::claim(&a, 1).unwrap();
    reserve(&mut flow, &a);
    flow.deadline = Instant::now();
    assert_eq!(
        flow.host_succeeded(&a, 1, success(&a)),
        Err(Error::ChallengeExpired)
    );
    assert!(flow.host_effect_reserved());
    assert_eq!(flow.phase(), WindowPhase::Denied(Error::ChallengeExpired));
    let mut expired = fixture();
    expired.scope.challenge_expires_at = 1;
    assert!(matches!(
        WindowFlow::claim(&expired, 1),
        Err(Error::ChallengeExpired)
    ));
}
