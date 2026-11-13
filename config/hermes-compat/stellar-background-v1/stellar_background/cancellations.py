"""Bounded canonical observer obligations, never an execution queue or effect authority."""
from __future__ import annotations

import asyncio

from .contract import ContractError


def reserve(conn, binding_id=None):
    # Same transaction as revocation/cancellation. Includes a submit which wins before revoke,
    # and survives commit-then-error without depending on the caller receiving an ACK.
    conn.execute('INSERT OR IGNORE INTO stellar_bg_cancellations_v1 '
        'SELECT a.admission_id,e.binding_id,a.target_session_id,0 FROM session_admissions a '
        'JOIN stellar_bg_events_v1 e ON e.request_id=a.request_id JOIN stellar_bg_bindings_v1 b USING(binding_id) '
        "WHERE a.status='queued' AND a.principal_id='automation:' || json_extract(b.origin_json,'$.route') "
        "AND a.target_session_id=json_extract(b.origin_json,'$.sessionId') "
        'AND (? IS NULL OR e.binding_id=?)', (binding_id, binding_id))


async def pay(host, binding_id, result):
    from gateway.session_contract import SessionRef
    from gateway.session_runtime_workers import tracked_write
    from hermes_state_runtime import get_session_admission
    authority, db = host.authority, host.authority.db
    lock = getattr(authority, '_stellar_cancellation_lock', None)
    if lock is None:
        lock = authority._stellar_cancellation_lock = asyncio.Lock()
    async with lock:
        with db._read_ctx() as conn:
            rows = conn.execute('SELECT * FROM stellar_bg_cancellations_v1 '
                'WHERE notified=0 AND (? IS NULL OR binding_id=?) ORDER BY admission_id', (binding_id, binding_id)).fetchall()
        for saved in rows:
            row = get_session_admission(db, admission_id=saved['admission_id'])
            if row is None or (row['status'], row['outcome'], row['target_session_id']) != ('terminal', 'cancelled', saved['session_id']):
                raise ContractError('cancellation_unknown')
            authority.cancel_obligations.add(saved['admission_id'])
            authority._settle_cancelled(SessionRef(authority.profile_id, saved['session_id']), saved['admission_id'])
            # Publication may have occurred before a failure. Retry can repeat the canonical
            # frame; stable admission/event identity and effect custody prevent a second effect.
            await tracked_write(authority, lambda ident=saved['admission_id']: db._execute_write(
                lambda conn: conn.execute('UPDATE stellar_bg_cancellations_v1 SET notified=1 WHERE admission_id=?', (ident,))))
    return result
