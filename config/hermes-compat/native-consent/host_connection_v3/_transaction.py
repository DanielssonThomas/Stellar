"""Private DATA composition. No connection authentication or consent factory."""
from journal_v3 import consume_binding_on, cancel_on
from journal_v3.errors import require
from stellar_background import Ledger, Origin


class _TransactionWriter:
    """Exactly one synchronous Ledger callback in the existing caller transaction."""
    def __init__(self, conn):
        self._conn = conn
        self._active = True
        self._entered = False

    def _execute_write(self, callback):
        require(self._active and not self._entered, 'write_uncertain')
        require(self._conn.in_transaction, 'write_uncertain')
        self._entered = True
        return callback(self._conn)

    def close(self):
        self._active = False
        self._conn = None


def bind_on(conn, context, scope, ticket_hash, fresh_now):
    """Data only. Future actual host lease/policy gate is additionally required."""
    writer = _TransactionWriter(conn)
    try:
        revision = conn.execute('SELECT COALESCE(MAX(revision),0)+1 '
            'FROM main.stellar_bg_bindings_v1').fetchone()[0]
        def gate(_conn, binding):
            fresh_now()
            return _conn is conn and binding['origin'] == scope['origin']
        ledger = Ledger(writer, producer_id=scope['origin']['producerId'],
            profile_id=scope['origin']['profileId'], gate=gate, clock=fresh_now)
        def hook(current, binding):
            consume_binding_on(current, scope['challengeId'], context, ticket_hash, binding, fresh_now())
        return ledger.bind(Origin(**scope['origin']), consent_revision=revision,
            expires_at=scope['expiresAt'], max_admissions=scope['maxAdmissions'], _on_bind=hook)
    finally:
        writer.close()


def cancel_binding_on(conn, context, scope):
    # _revoke_on only uses this retained conn; it never calls the writer/gate.
    ledger = Ledger(None, producer_id=scope['origin']['producerId'],
        profile_id=scope['origin']['profileId'], gate=lambda *_: False)
    return cancel_on(conn, scope['challengeId'], context, revoke_binding_on=ledger._revoke_on)
