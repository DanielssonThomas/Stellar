"""Bounded same-snapshot row verification. Metadata inspection is never recovery authority."""
from .errors import require
from .schema import ATTEMPT, verify_schema_on
from .validation import context, prepared, unpack, digest, hexid, integer, canonical


def rows(conn, sql, params=(), cap=64):
    cursor = conn.execute(sql + f' LIMIT {cap + 1}', params)
    keys = [column[0] for column in cursor.description]
    found = [dict(zip(keys, row)) for row in cursor.fetchall()]
    require(len(found) <= cap, 'canonical_capacity')
    return found


def one(conn, sql, params=()):
    found = rows(conn, sql, params, cap=1)
    require(len(found) == 1, 'journal_missing')
    return found[0]


def bound_row(conn, attempt, captured, scope):
    binding = one(conn, 'SELECT * FROM main.stellar_bg_bindings_v1 WHERE binding_id=?', (attempt['binding_id'],))
    require(binding['origin_json'] == canonical(scope['origin']), 'binding_mismatch')
    require(binding['expires'] == scope['expiresAt'] and binding['maximum'] == scope['maxAdmissions'], 'binding_mismatch')
    integer(binding['revision'], 1)
    integer(binding['created'])
    integer(binding['spent'], 0, binding['maximum'])
    require(binding['revoked'] in (0, 1) and (not attempt['deny_requested'] or binding['revoked'] == 1), 'binding_mismatch')
    require(attempt['created_ms'] <= binding['created'] < scope['expiresAt'], 'binding_mismatch')
    owner = one(conn, 'SELECT * FROM main.stellar_bg_owners_v1 WHERE binding_id=?', (attempt['binding_id'],))
    require(owner['subject'] == captured['ownerSubject'], 'binding_mismatch')


def decode_row(conn, row):
    captured = context(unpack(row['context_json'], 8192))
    scope = prepared(unpack(row['prepared_json'], 16384), row['created_ms'])
    require(row['context_digest'] == digest(row['context_json']) and row['prepared_digest'] == digest(row['prepared_json']), 'journal_corrupt')
    require(row['profile_id'] == captured['profileId'] == scope['origin']['profileId']
            and row['attachment_id'] == captured['attachmentId']
            and row['challenge_id'] == scope['challengeId'], 'journal_corrupt')
    hexid(row['challenge_id'])
    for field in ('deny_requested', 'release_reserved'):
        integer(row[field], 0, 1)
    phase = row['phase']
    require(phase in ('pending', 'confirming', 'issuing', 'issued', 'bound', 'cancelled'), 'journal_corrupt')
    for field, size in [('intent_id', 64), ('ticket_hash', 64), ('binding_id', 32)]:
        if row[field] is not None:
            hexid(row[field], size)
    if phase in ('pending', 'confirming', 'cancelled'):
        require(all(row[k] is None for k in ('intent_id', 'ticket_hash', 'ticket_deadline_ms', 'binding_id'))
                and row['release_reserved'] == 0, 'journal_corrupt')
    else:
        require(row['intent_id'] is not None, 'journal_corrupt')
    if phase == 'issuing':
        require(all(row[k] is None for k in ('ticket_hash', 'ticket_deadline_ms', 'binding_id'))
                and row['release_reserved'] == 0, 'journal_corrupt')
    if phase in ('issued', 'bound'):
        require(row['ticket_hash'] is not None, 'journal_corrupt')
        integer(row['ticket_deadline_ms'], row['created_ms'] + 1, scope['expiresAt'])
    if phase == 'issued':
        require(row['binding_id'] is None, 'journal_corrupt')
    if phase == 'cancelled':
        require(row['deny_requested'] == 1, 'journal_corrupt')
    if phase == 'bound':
        require(row['binding_id'] is not None and row['release_reserved'] == 1, 'journal_corrupt')
        bound_row(conn, row, captured, scope)
    return captured, scope


def verify_on(conn):
    verify_schema_on(conn)
    found = rows(conn, f'SELECT * FROM main.{ATTEMPT}')
    require(len(found) <= 64, 'journal_capacity')
    for row in found:
        decode_row(conn, row)


def load_on(conn, challenge, captured=None):
    verify_on(conn)
    hexid(challenge)
    row = one(conn, f'SELECT * FROM main.{ATTEMPT} WHERE challenge_id=?', (challenge,))
    original, scope = decode_row(conn, row)
    if captured is not None:
        require(context(captured) == original, 'context_changed')
    return row, original, scope
