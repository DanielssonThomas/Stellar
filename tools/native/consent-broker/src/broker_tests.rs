use super::*;
use crate::tests::scope;

fn fixture(id: u8) -> (Broker, Attachment) {
    (Broker { entries: vec![] }, attachment(id))
}

fn attachment(id: u8) -> Attachment {
    Attachment {
        identity: [id; 32],
        policy: [1; 32],
        generation: 1,
        scope: scope(id as usize, id as usize),
        alive: true,
        token: Arc::new(()),
        flow_claimed: std::sync::atomic::AtomicBool::new(false),
    }
}

// Synthetic callback association only. Never OS/human verification evidence.
fn fixture_callback(broker: &Broker) -> Verification {
    let entry = broker.entries.last().unwrap();
    Verification {
        attachment: entry.attachment,
        generation: entry.generation,
        digest: entry.digest,
        token: Arc::clone(&entry.token),
    }
}

#[test]
fn digest_matches_pinned_python_canonical_utf8_vector() {
    let mut value = scope(1, 2);
    value.origin.session_id = "session-\u{e5}".into();
    value.display_scope.profile_label = "Iv\u{fd}".into();
    value.expires_at = 120_000;
    value.challenge_expires_at = 60_000;
    let actual: String = digest(&value, &[1; 32], 1)
        .unwrap()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // Independently computed with CPython sort_keys/ensure_ascii=False/separators.
    assert_eq!(
        actual,
        "dece1129da4399247ea32f19476124e0f86fbda48b704f032d2f0554d6242b86"
    );
    assert_ne!(
        digest(&value, &[1; 32], 1).unwrap(),
        digest(&value, &[2; 32], 1).unwrap()
    );
    assert_ne!(
        digest(&value, &[1; 32], 1).unwrap(),
        digest(&value, &[1; 32], 2).unwrap()
    );
}

#[test]
fn reserves_one_prompt_and_requires_private_callback() {
    let (mut broker, a) = fixture(1);
    assert_eq!(broker.prepare(&a).unwrap(), a.scope);
    assert_eq!(
        broker
            .verified(&a, &a.scope.challenge_id, fixture_callback(&broker))
            .err(),
        Some(Error::ApprovalRequired)
    );
    assert_eq!(broker.begin(&a, &a.scope.challenge_id), Ok(()));
    assert_eq!(broker.begin(&a, &a.scope.challenge_id), Err(Error::Busy));
    let callback = fixture_callback(&broker);
    let intent = broker
        .verified(&a, &a.scope.challenge_id, callback)
        .unwrap();
    assert_eq!(
        broker.begin(&a, &a.scope.challenge_id),
        Err(Error::ChallengeConsumed)
    );
    assert_eq!(broker.reserve_intent(&a, intent), Ok(()));
    assert_eq!(
        broker.begin(&a, &a.scope.challenge_id),
        Err(Error::Uncertain)
    );
    assert_eq!(
        broker.cancel(&a, &a.scope.challenge_id),
        Err(Error::Uncertain)
    );
    assert_eq!(broker.prepare(&a), Err(Error::Uncertain));
}

#[test]
fn cancel_before_and_during_confirmation_fences_late_callback() {
    for confirming in [false, true] {
        let (mut broker, a) = fixture(1);
        broker.prepare(&a).unwrap();
        if confirming {
            broker.begin(&a, &a.scope.challenge_id).unwrap();
        }
        let callback = fixture_callback(&broker);
        assert_eq!(broker.cancel(&a, &a.scope.challenge_id), Ok(()));
        assert_eq!(
            broker.verified(&a, &a.scope.challenge_id, callback).err(),
            Some(Error::ChallengeCancelled)
        );
        assert_eq!(
            broker.cancel(&a, &a.scope.challenge_id),
            Err(Error::ChallengeCancelled)
        );
        assert_eq!(broker.prepare(&a), Err(Error::Uncertain));
    }
}

#[test]
fn consumed_challenge_cannot_report_successful_rollback() {
    let (mut broker, a) = fixture(1);
    broker.prepare(&a).unwrap();
    broker.begin(&a, &a.scope.challenge_id).unwrap();
    let callback = fixture_callback(&broker);
    let _intent = broker
        .verified(&a, &a.scope.challenge_id, callback)
        .unwrap();
    assert_eq!(
        broker.cancel(&a, &a.scope.challenge_id),
        Err(Error::ChallengeConsumed)
    );
    assert_eq!(
        broker
            .verified(&a, &a.scope.challenge_id, fixture_callback(&broker))
            .err(),
        Some(Error::ChallengeConsumed)
    );
}

#[test]
fn invalidation_fences_callback_and_consumed_intent() {
    for consumed in [false, true] {
        let (mut broker, mut a) = fixture(1);
        broker.prepare(&a).unwrap();
        broker.begin(&a, &a.scope.challenge_id).unwrap();
        let callback = fixture_callback(&broker);
        if consumed {
            let intent = broker
                .verified(&a, &a.scope.challenge_id, callback)
                .unwrap();
            broker.invalidate(&mut a);
            assert_eq!(
                broker.reserve_intent(&a, intent),
                Err(Error::TransportChanged)
            );
        } else {
            broker.invalidate(&mut a);
            assert_eq!(
                broker.verified(&a, &a.scope.challenge_id, callback).err(),
                Some(Error::TransportChanged)
            );
        }
        assert_eq!(broker.prepare(&a), Err(Error::TransportChanged));
    }
}

#[test]
fn scope_and_policy_changes_are_terminal() {
    for policy in [false, true] {
        let (mut broker, mut a) = fixture(1);
        broker.prepare(&a).unwrap();
        broker.begin(&a, &a.scope.challenge_id).unwrap();
        let callback = fixture_callback(&broker);
        if policy {
            a.policy[0] = 9;
        } else {
            a.scope.origin.physical_target = "compressed-tip".into();
        }
        let expected = if policy {
            Error::PolicyChanged
        } else {
            Error::OriginChanged
        };
        assert_eq!(
            broker.verified(&a, &a.scope.challenge_id, callback).err(),
            Some(expected)
        );
        a.policy = [1; 32];
        a.scope.origin.physical_target = "physical-1".into();
        assert_eq!(
            broker.begin(&a, &a.scope.challenge_id),
            Err(Error::ChallengeCancelled)
        );
    }
}

#[test]
fn options_display_and_all_origin_fields_are_bound() {
    let mut alternatives = vec![];
    let base = scope(1, 1);
    macro_rules! change {
        ($field:ident) => {{
            let mut v = base.clone();
            v.origin.$field.push('x');
            alternatives.push(v);
        }};
    }
    change!(profile_id);
    change!(session_id);
    change!(physical_target);
    change!(route);
    change!(producer_id);
    change!(worker_incarnation);
    let mut v = base.clone();
    v.max_admissions += 1;
    alternatives.push(v);
    let mut v = base.clone();
    v.expires_at += 1;
    alternatives.push(v);
    let mut v = base.clone();
    v.display_scope.producer_label.push('x');
    alternatives.push(v);
    let mut v = base.clone();
    v.connection_binding.push('x');
    alternatives.push(v);
    for value in alternatives {
        let (mut broker, mut a) = fixture(1);
        broker.prepare(&a).unwrap();
        broker.begin(&a, &a.scope.challenge_id).unwrap();
        let callback = fixture_callback(&broker);
        // Test-only mutation represents a broken custody/scope adapter.
        a.scope = value;
        assert_eq!(
            broker.verified(&a, &base.challenge_id, callback).err(),
            Some(Error::OriginChanged)
        );
    }
}

#[test]
fn wrong_peer_generation_and_callback_refuse() {
    let (mut broker, mut a) = fixture(1);
    broker.prepare(&a).unwrap();
    broker.begin(&a, &a.scope.challenge_id).unwrap();
    let other = attachment(2);
    assert_eq!(
        broker.cancel(&other, &a.scope.challenge_id),
        Err(Error::TransportChanged)
    );
    a.generation += 1;
    assert_eq!(
        broker.begin(&a, &a.scope.challenge_id),
        Err(Error::TransportChanged)
    );
    a.generation -= 1;
    let mut callback = fixture_callback(&broker);
    callback.digest[0] ^= 1;
    assert_eq!(
        broker.verified(&a, &a.scope.challenge_id, callback).err(),
        Some(Error::Uncertain)
    );
    assert_eq!(
        broker.begin(&a, &a.scope.challenge_id),
        Err(Error::Uncertain)
    );
    assert_eq!(
        broker.cancel(&a, &"f".repeat(64)),
        Err(Error::ChallengeUnknown)
    );
}

#[test]
fn copied_attachment_fields_and_wrong_callback_lineage_are_not_authority() {
    let (mut broker, a) = fixture(1);
    broker.prepare(&a).unwrap();
    let mut copied = attachment(1);
    copied.scope = a.scope.clone();
    assert_eq!(
        broker.begin(&copied, &a.scope.challenge_id),
        Err(Error::TransportChanged)
    );
    broker.begin(&a, &a.scope.challenge_id).unwrap();
    let mut callback = fixture_callback(&broker);
    callback.token = Arc::new(());
    assert_eq!(
        broker.verified(&a, &a.scope.challenge_id, callback).err(),
        Some(Error::Uncertain)
    );
    assert_eq!(
        broker.begin(&a, &a.scope.challenge_id),
        Err(Error::Uncertain)
    );
}

#[test]
fn monotonic_expiry_prevents_late_callback_and_intent() {
    for consumed in [false, true] {
        let (mut broker, a) = fixture(1);
        broker.prepare(&a).unwrap();
        broker.begin(&a, &a.scope.challenge_id).unwrap();
        let callback = fixture_callback(&broker);
        if consumed {
            let intent = broker
                .verified(&a, &a.scope.challenge_id, callback)
                .unwrap();
            broker.entries[0].deadline = Instant::now();
            assert_eq!(
                broker.reserve_intent(&a, intent),
                Err(Error::ChallengeExpired)
            );
        } else {
            broker.entries[0].deadline = Instant::now();
            assert_eq!(
                broker.verified(&a, &a.scope.challenge_id, callback).err(),
                Some(Error::ChallengeExpired)
            );
        }
        assert_eq!(
            broker.cancel(&a, &a.scope.challenge_id),
            Err(Error::ChallengeExpired)
        );
        assert_eq!(broker.prepare(&a), Err(Error::Uncertain));
    }
}

#[test]
fn wall_expiry_and_overlong_grants_refuse() {
    for (challenge, grant) in [(0, 120_000), (60_001, 120_000), (60_000, 604_800_001)] {
        let (mut broker, mut a) = fixture(1);
        let (wall, _) = now().unwrap();
        a.scope.challenge_expires_at = wall + challenge;
        a.scope.expires_at = wall + grant;
        // Large margin avoids a time-dependent 60001ms boundary race in this negative case.
        if challenge > 60_000 {
            a.scope.challenge_expires_at += 1_000;
        }
        if grant > 604_800_000 {
            a.scope.expires_at += 1_000;
        }
        assert_eq!(broker.prepare(&a), Err(Error::ChallengeExpired));
    }
}

#[test]
fn pending_and_tombstone_capacity_never_evict() {
    let (mut broker, _) = fixture(1);
    let attachments: Vec<_> = (1..=16).map(attachment).collect();
    for a in &attachments {
        broker.prepare(a).unwrap();
    }
    assert_eq!(broker.prepare(&attachment(17)), Err(Error::Busy));
    for a in &attachments {
        broker.cancel(a, &a.scope.challenge_id).unwrap();
    }
    for id in 17..=64 {
        let a = attachment(id);
        broker.prepare(&a).unwrap();
        broker.cancel(&a, &a.scope.challenge_id).unwrap();
    }
    assert_eq!(broker.entries.len(), 64);
    assert_eq!(broker.prepare(&attachment(65)), Err(Error::Busy));
    assert_eq!(broker.entries[0].state as u8, State::Cancelled as u8);
}
