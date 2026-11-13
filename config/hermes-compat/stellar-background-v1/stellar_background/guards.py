"""Transaction-local claim/terminal checks and durable consumer effect custody.

These are host integration ports, not a claim that the managed runtime invokes them.
Revocation cannot recall an emitted effect. It never reports stopped while an effect owner
still has custody, even if that owner disconnected or an acknowledgement was lost.
"""
from __future__ import annotations

import json

from .contract import CAPABILITY, ContractError, canonical, text


class GuardMixin:
    def guard_claim(self, conn, row):
        payload = row['payload'] if 'payload' in row else json.loads(row['payload_json'])
        card = payload.get('local_automation_v1', {}).get('background_v1')
        if card is None and not (row['request_id'].startswith(CAPABILITY + ':')
                                 and row['principal_id'].startswith('automation:')):
            return  # Ordinary foreground and unrelated host automation are unchanged.
        saved = conn.execute('SELECT * FROM stellar_bg_events_v1 WHERE request_id=?',
                             (row['request_id'],)).fetchone()
        if saved is None or canonical(card) != saved['descriptor_json']:
            raise ContractError('untrusted_descriptor')
        binding = self._get(conn, saved['binding_id'])
        self._valid(conn, binding)
        descriptor = json.loads(saved['descriptor_json'])
        if self.clock() >= descriptor['eventExpiresAt']:
            raise ContractError('event_expired')
        origin = binding['origin']
        envelope = payload['local_automation_v1']
        if (row['target_session_id'] != origin['sessionId']
                or row['principal_id'] != 'automation:' + origin['route']
                or envelope.get('identity') != row['request_id']
                or envelope.get('owner') != origin['sessionId']
                or envelope.get('target') != origin['physicalTarget']
                or envelope.get('route') != origin['route']
                or envelope.get('display_kind') != 'lifecycle_update'):
            raise ContractError('untrusted_descriptor')

    def guard_terminal(self, conn, row):
        """Compose into canonical settlement's transaction; revoked completion cannot commit success.

        The host adapter must settle an interrupted/unknown result without delivery when this
        refuses. It must not turn a refusal into a completed response or delete an uncertain row.
        """
        return self.guard_claim(conn, row)

    def begin_effect(self, binding_id, event_id, digest, *, client, operation, kind):
        """Host-authenticated consumer only; operation is its durable exact-retry identifier."""
        text(client, 256, identifier=True)
        text(operation, 256, identifier=True)
        if kind not in ('render', 'speech'):
            raise ContractError('invalid_params')
        def write(conn):
            binding = self._get(conn, binding_id)
            saved = conn.execute('SELECT * FROM stellar_bg_events_v1 WHERE binding_id=? AND event_id=?',
                                 (binding_id, event_id)).fetchone()
            if saved is None:
                raise ContractError('unknown')
            if saved['digest'] != digest:
                raise ContractError('conflict')
            row = self._admission(conn, binding, saved)
            if row is None:
                raise ContractError('unknown')
            self.guard_claim(conn, row)
            receipt = self._inspect(conn, binding, saved)
            response = receipt.get('receipt', {}).get('result', {}).get('final_response')
            if (row['status'] != 'terminal' or row['outcome'] != 'completed' or not response
                    or not response.strip() or receipt['deliveryAuthorized'] is not True):
                raise ContractError('result_unavailable')
            previous = conn.execute('SELECT * FROM stellar_bg_effects_v1 WHERE binding_id=? AND event_id=? AND kind=?',
                                   (binding_id, event_id, kind)).fetchone()
            if previous is not None:
                if previous['client'] != client or previous['operation'] != operation:
                    raise ContractError('effect_already_claimed')
                # Exact retry reconciles custody, never authorizes the effect a second time.
                return {'status': 'finished' if previous['finished'] else 'unknown', 'execute': False}
            conn.execute('INSERT INTO stellar_bg_effects_v1 VALUES(?,?,?,?,?,0)',
                         (binding_id, event_id, kind, client, operation))
            return {'status': 'claimed', 'execute': True}
        return self.db._execute_write(write)

    def settle(self, *, epoch, admission_id, generation, result):
        """Host executor port: a denied completion settles interrupted without publishing its answer.

        This retries only a rolled-back settlement, never inference/admission. Epoch/generation or
        infrastructure uncertainty propagates; the adapter must not synthesize a successful frame.
        """
        from hermes_state_runtime import settle_session_input
        try:
            return settle_session_input(self.db, epoch=epoch, admission_id=admission_id,
                generation=generation, outcome='completed', result=result,
                _terminal_write=lambda conn, row: self.guard_terminal(conn, row))
        except ContractError as exc:
            if exc.code not in ('consent_unavailable', 'binding_changed', 'event_expired', 'host_unavailable'):
                raise
            return settle_session_input(self.db, epoch=epoch, admission_id=admission_id,
                generation=generation, outcome='interrupted', result={'result': {'final_response': ''}})

    def finish_effect(self, binding_id, event_id, *, client, operation, kind):
        def write(conn):
            self._get(conn, binding_id)  # Revision may be revoked; its exact owner can still close custody.
            result = conn.execute('UPDATE stellar_bg_effects_v1 SET finished=1 WHERE binding_id=? AND event_id=? '
                'AND kind=? AND client=? AND operation=?', (binding_id, event_id, kind, client, operation))
            if result.rowcount != 1:
                raise ContractError('effect_owner_mismatch')
            return self._revocation(conn, binding_id)
        return self.db._execute_write(write)

    @staticmethod
    def _revocation(conn, binding_id):
        revoked = conn.execute('SELECT revoked FROM stellar_bg_bindings_v1 WHERE binding_id=?', (binding_id,)).fetchone()[0]
        active = conn.execute('SELECT count(*) FROM stellar_bg_effects_v1 WHERE binding_id=? AND finished=0',
                              (binding_id,)).fetchone()[0]
        return {'status': ('revoking' if active else 'revoked') if revoked else 'active',
                'revocationCommitted': bool(revoked), 'effectsStopped': bool(revoked) and active == 0}

    def revoke(self, binding_id):
        return self.db._execute_write(lambda conn: self._revoke_on(conn, binding_id))

    def _revoke_on(self, conn, binding_id):
        binding = self._get(conn, binding_id)
        from .cancellations import reserve
        reserve(conn, binding_id)
        conn.execute('UPDATE stellar_bg_bindings_v1 SET revoked=1 WHERE binding_id=?', (binding_id,))
        conn.execute("UPDATE session_admissions SET status='terminal',outcome='cancelled' "
            "WHERE status='queued' AND principal_id=? AND target_session_id=? AND request_id IN "
            '(SELECT request_id FROM stellar_bg_events_v1 WHERE binding_id=?)',
            ('automation:' + binding['origin']['route'], binding['origin']['sessionId'], binding_id))
        return self._revocation(conn, binding_id)
