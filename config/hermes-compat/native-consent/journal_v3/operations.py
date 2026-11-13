"""Uncommitted, connection-local transitions; no ticket/proof/native authority factory."""
from .errors import require
from .schema import ATTEMPT
from .integrity import load_on, verify_on, one
from .validation import integer, hexid, pack_context, pack_prepared, canonical


def fresh(row, scope, now_ms):
    integer(now_ms, row['created_ms'])
    require(now_ms < min(scope['expiresAt'], scope['challengeExpiresAt']), 'consent_expired')
    if row['ticket_deadline_ms'] is not None:
        require(now_ms < row['ticket_deadline_ms'], 'consent_expired')


def positive(conn, challenge, captured, now_ms, phase):
    row, original, scope = load_on(conn, challenge, captured)
    fresh(row, scope, now_ms)
    require(row['deny_requested'] == 0 and row['phase'] == phase, 'consent_uncertain')
    return row, original, scope


def reserve_on(conn, captured, scope, now_ms):
    verify_on(conn)
    integer(now_ms)
    context_json, context_digest = pack_context(captured)
    prepared_json, prepared_digest = pack_prepared(scope, now_ms)
    require(conn.execute(f'SELECT count(*) FROM main.{ATTEMPT} WHERE profile_id=?', ('ivy',)).fetchone()[0] == 0,
            'consent_uncertain')
    conn.execute(f'''INSERT INTO main.{ATTEMPT}
        (challenge_id,profile_id,attachment_id,context_json,context_digest,prepared_json,prepared_digest,
         created_ms,phase,deny_requested,release_reserved) VALUES(?,?,?,?,?,?,?,?,'pending',0,0)''',
        (scope['challengeId'], 'ivy', captured['attachmentId'], context_json, context_digest,
         prepared_json, prepared_digest, now_ms))
    verify_on(conn)


def begin_on(conn, challenge, captured, now_ms):
    positive(conn, challenge, captured, now_ms, 'pending')
    conn.execute(f"UPDATE main.{ATTEMPT} SET phase='confirming' WHERE challenge_id=?", (challenge,))
    verify_on(conn)


def reserve_issue_on(conn, challenge, captured, intent_id, now_ms):
    positive(conn, challenge, captured, now_ms, 'confirming')
    hexid(intent_id)
    conn.execute(f"UPDATE main.{ATTEMPT} SET phase='issuing',intent_id=? WHERE challenge_id=?", (intent_id, challenge))
    verify_on(conn)


def record_ticket_on(conn, challenge, captured, intent_id, ticket_hash, deadline_ms, now_ms):
    row, _, scope = positive(conn, challenge, captured, now_ms, 'issuing')
    require(hexid(intent_id) == row['intent_id'], 'consent_uncertain')
    hexid(ticket_hash)
    integer(deadline_ms, now_ms + 1, min(scope['expiresAt'], now_ms + 60000))
    conn.execute(f"UPDATE main.{ATTEMPT} SET phase='issued',ticket_hash=?,ticket_deadline_ms=? WHERE challenge_id=?",
                 (ticket_hash, deadline_ms, challenge))
    verify_on(conn)


def reserve_release_on(conn, challenge, captured, now_ms):
    row, _, _ = positive(conn, challenge, captured, now_ms, 'issued')
    require(row['release_reserved'] == 0, 'consent_uncertain')
    conn.execute(f'UPDATE main.{ATTEMPT} SET release_reserved=1 WHERE challenge_id=?', (challenge,))
    verify_on(conn)


def consume_binding_on(conn, challenge, captured, ticket_hash, binding, now_ms):
    """Fresh actual Ledger.bind hook ONLY, using a fresh clock inside that callback.

    A SELECT cannot prove insertion freshness. This data function authenticates
    neither its caller nor a ticket; it composes the reviewed same-TX invariant.
    """
    row, original, scope = positive(conn, challenge, captured, now_ms, 'issued')
    require(row['release_reserved'] == 1 and hexid(ticket_hash) == row['ticket_hash'], 'consent_uncertain')
    require(type(binding) is dict and set(binding) == set(
        'bindingId origin consentRevision expiresAt maxAdmissions spent revoked createdAt'.split()), 'binding_mismatch')
    key = hexid(binding['bindingId'], 32)
    actual = one(conn, 'SELECT * FROM main.stellar_bg_bindings_v1 WHERE binding_id=?', (key,))
    integer(binding['createdAt'], row['created_ms'], now_ms)
    require(binding['origin'] == scope['origin'] and binding['expiresAt'] == scope['expiresAt']
            and binding['maxAdmissions'] == scope['maxAdmissions'] and binding['revoked'] is False, 'binding_mismatch')
    integer(binding['spent'], 0, 0)
    integer(binding['consentRevision'], 1)
    require(actual == {'binding_id': key, 'origin_json': canonical(scope['origin']),
        'revision': binding['consentRevision'], 'expires': scope['expiresAt'], 'maximum': scope['maxAdmissions'],
        'spent': 0, 'revoked': 0, 'created': binding['createdAt']}, 'binding_mismatch')
    conn.execute('INSERT INTO main.stellar_bg_owners_v1 VALUES(?,?)', (key, original['ownerSubject']))
    conn.execute(f"UPDATE main.{ATTEMPT} SET phase='bound',binding_id=? WHERE challenge_id=?", (key, challenge))
    verify_on(conn)


def inspect_on(conn, challenge):
    row, _, _ = load_on(conn, challenge)
    return row  # Uncommitted/snapshot metadata only; never a receipt or retry permission.
