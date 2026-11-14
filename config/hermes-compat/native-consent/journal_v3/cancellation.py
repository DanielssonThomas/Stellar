"""Sticky same-transaction denial; canonical revocation cannot finish local custody."""
from .schema import ATTEMPT
from .errors import require
from .integrity import load_on, verify_on, one, rows


def snapshot(conn, key, scope):
    binding = one(conn, 'SELECT * FROM main.stellar_bg_bindings_v1 WHERE binding_id=?', (key,))
    owner = rows(conn, 'SELECT * FROM main.stellar_bg_owners_v1 WHERE binding_id=?', (key,), cap=1)
    events = rows(conn, 'SELECT * FROM main.stellar_bg_events_v1 WHERE binding_id=? ORDER BY event_id', (key,), cap=100)
    effects = rows(conn, 'SELECT * FROM main.stellar_bg_effects_v1 WHERE binding_id=? ORDER BY event_id,kind', (key,), cap=200)
    obligations = rows(conn, 'SELECT * FROM main.stellar_bg_cancellations_v1 WHERE binding_id=? ORDER BY admission_id', (key,), cap=100)
    admissions = rows(conn, 'SELECT a.* FROM main.session_admissions a JOIN main.stellar_bg_events_v1 e '
        'ON e.request_id=a.request_id WHERE e.binding_id=? ORDER BY a.admission_id', (key,), cap=100)
    queued = [a for a in admissions if a['status'] == 'queued'
        and a['principal_id'] == 'automation:' + scope['origin']['route']
        and a['target_session_id'] == scope['origin']['sessionId']]
    require(len(queued) <= 16, 'canonical_capacity')
    return binding, owner, events, effects, obligations, admissions, queued


def cancel_on(conn, challenge, captured, revoke_binding_on=None):
    row, _, scope = load_on(conn, challenge, captured)
    conn.execute(f'UPDATE main.{ATTEMPT} SET deny_requested=1 WHERE challenge_id=?', (challenge,))
    if row['phase'] in ('pending', 'confirming', 'cancelled'):
        conn.execute(f"UPDATE main.{ATTEMPT} SET phase='cancelled' WHERE challenge_id=?", (challenge,))
        verify_on(conn)
        return 'cancelled_before_issue'  # Domain classification, NOT a committed native cancel ACK.
    if row['phase'] == 'bound':
        require(callable(revoke_binding_on), 'revocation_unavailable')
        key = row['binding_id']
        before, owner, events, effects, obligations, admissions, queued = snapshot(conn, key, scope)
        revoke_binding_on(conn, key)
        after, owner2, events2, effects2, obligations2, admissions2, queued2 = snapshot(conn, key, scope)
        require(after == {**before, 'revoked': 1} and owner == owner2 and events == events2
                and effects == effects2 and not queued2, 'revocation_mismatch')
        expected = {r['admission_id']: r for r in obligations}
        queued_ids = {a['admission_id'] for a in queued}
        expected_admissions = [{**a, 'status': 'terminal', 'outcome': 'cancelled'}
            if a['admission_id'] in queued_ids else a for a in admissions]
        require(admissions2 == expected_admissions, 'revocation_mismatch')
        for admission in queued:
            current = one(conn, 'SELECT * FROM main.session_admissions WHERE admission_id=?', (admission['admission_id'],))
            require(current == {**admission, 'status': 'terminal', 'outcome': 'cancelled'}, 'revocation_mismatch')
            expected.setdefault(admission['admission_id'], {'admission_id': admission['admission_id'],
                'binding_id': key, 'session_id': scope['origin']['sessionId'], 'notified': 0})
        require({r['admission_id']: r for r in obligations2} == expected, 'revocation_mismatch')
    verify_on(conn)
    return 'uncertain_revoking'  # Neither rollback nor physical/native stop proof.
