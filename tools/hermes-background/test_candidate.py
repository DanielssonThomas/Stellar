"""Exercise the inactive candidate against actual Hermes SQLite admission transactions."""
from __future__ import annotations

import argparse
import concurrent.futures
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
import threading
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]


class CandidateTests(unittest.TestCase):
    def setUp(self):
        from hermes_state import SessionDB
        from hermes_state_runtime import begin_runtime_epoch
        from stellar_background import Ledger, Origin
        from stellar_background.schema import install_schema
        self.tmp = tempfile.TemporaryDirectory(prefix='stellar339-ledger-')
        self.path = Path(self.tmp.name) / 'canonical.db'
        self.db = SessionDB(self.path)
        self.db.create_session('original', source='local')
        self.epoch = begin_runtime_epoch(self.db, instance_id='isolated-fixture')
        install_schema(self.db)
        self.now = 1_700_000_000_000
        self.host_available = True
        self.origin = Origin('fixture-ivy', 'original', 'original', 'fixture-route', 'stellar-herdr', 'a' * 32)
        self.ledger = Ledger(self.db, producer_id='stellar-herdr', profile_id='fixture-ivy',
                             gate=self.gate, clock=lambda: self.now)
        self.binding = self.ledger.bind(self.origin, consent_revision=1,
                                       expires_at=self.now + 600_000, max_admissions=100)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def gate(self, conn, binding):
        # Synthetic host policy port. DB facts are real; no live authority/session is fabricated.
        row = conn.execute('SELECT ended_at FROM sessions WHERE id=?',
                           (binding['origin']['physicalTarget'],)).fetchone()
        return self.host_available and binding['origin'] == self.origin.__dict__ and row is not None and row[0] is None

    def event(self, ident='event-1', fact=None):
        return {'schemaVersion': 1, 'eventId': ident, 'kind': 'lifecycle_update',
            'payload': {'milestone': 'waiting_review', 'fact': {'head': 'b' * 40} if fact is None else fact,
                        'observedAt': self.now}}

    def digest(self, event):
        from stellar_background import event_digest
        return event_digest(self.binding, event)

    def submit(self, event=None):
        return self.ledger.submit(self.binding['bindingId'], event or self.event(), epoch=self.epoch)

    def claim(self):
        from hermes_state_runtime import claim_session_input, list_session_admissions
        first = next((r for r in list_session_admissions(self.db, session_id='original') if r['status'] == 'queued'), None)
        return claim_session_input(self.db, epoch=self.epoch, session_id='original',
            head=first['admission_id'] if first else None,
            _guard=(lambda conn: self.ledger.guard_claim(conn, first)) if first else None)

    def complete(self, final='verified fixture answer'):
        from hermes_state_runtime import settle_session_input
        started = self.claim()
        settle_session_input(self.db, epoch=self.epoch, admission_id=started['admission_id'],
            generation=started['generation'], outcome='completed', result={'result': {'final_response': final}},
            _terminal_write=lambda conn, row: self.ledger.guard_terminal(conn, row))
        return started

    def counts(self):
        with self.db._read_ctx() as conn:
            return tuple(conn.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                for table in ('stellar_bg_events_v1', 'session_admissions'))

    def assertCode(self, code, operation):
        from stellar_background import ContractError
        with self.assertRaises(ContractError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def test_duplicate_conflict_and_canonical_terminal_receipt(self):
        first = self.submit()
        self.assertEqual(self.submit()['receipt'], first['receipt'])
        self.assertCode('conflict', lambda: self.submit(self.event(fact={'head': 'c' * 40})))
        self.complete()
        final = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertEqual(final['receipt']['result']['final_response'], 'verified fixture answer')
        self.assertEqual(final['receipt']['sequence'], first['receipt']['sequence'])
        self.assertEqual(final['receipt']['authority_epoch'], self.epoch)
        self.assertIsInstance(final['receipt']['execution_generation'], int)
        self.assertEqual(self.counts(), (1, 1))

    def test_lost_ack_and_reopen_find_original_admission(self):
        from stellar_background import Ledger
        from hermes_state import SessionDB
        with patch.object(self.ledger, 'inspect', side_effect=ConnectionError('lost ACK after commit')):
            with self.assertRaises(ConnectionError):
                self.submit()
        self.db.close()
        self.db = SessionDB(self.path)
        self.ledger = Ledger(self.db, producer_id='stellar-herdr', profile_id='fixture-ivy',
                             gate=self.gate, clock=lambda: self.now)
        result = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertEqual(result['status'], 'admitted')
        self.assertFalse(result['retryAuthorized'])
        self.assertEqual(self.submit()['receipt']['admission_id'], result['receipt']['admission_id'])
        self.assertEqual(self.counts(), (1, 1))

    def test_real_owner_epoch_recovery_preserves_unknown_without_execution_replay(self):
        from hermes_state_runtime import begin_runtime_epoch, recover_session_inputs
        first = self.submit(); self.claim()
        self.epoch = begin_runtime_epoch(self.db, instance_id='restarted-owner')
        self.assertEqual(recover_session_inputs(self.db, epoch=self.epoch), 1)
        result = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['receipt']['admission_id'], first['receipt']['admission_id'])
        self.assertFalse(result['retryAuthorized'])
        self.assertFalse(result['deliveryAuthorized'])
        self.assertEqual(self.submit()['status'], 'unknown')
        self.assertEqual(self.counts(), (1, 1))

    def test_cold_queued_admission_still_requires_current_host_gate(self):
        from hermes_state_runtime import begin_runtime_epoch, recover_session_inputs
        self.submit()
        self.epoch = begin_runtime_epoch(self.db, instance_id='restarted-owner')
        self.assertEqual(recover_session_inputs(self.db, epoch=self.epoch), 0)
        self.host_available = False
        self.assertCode('binding_changed', self.claim)

    def test_actual_canonical_retirement_and_tombstone_pruning_never_reactivate_event(self):
        from hermes_state_mutation_retirement import prune_retired_tombstones
        first = self.submit(); self.complete()
        self.assertTrue(self.db.delete_session('original'))
        result = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertEqual(result['status'], 'terminal')
        self.assertEqual(result['receipt']['admission_id'], first['receipt']['admission_id'])
        self.assertFalse(result['deliveryAuthorized'])
        self.assertCode('binding_changed', self.submit)
        self.db._execute_write(lambda conn: prune_retired_tombstones(conn, older_than=-1))
        missing = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertEqual(missing['status'], 'unknown')
        self.assertFalse(missing['retryAuthorized'])
        self.assertCode('binding_changed', self.submit)

    def test_concurrent_same_key_reserves_one_admission_and_one_budget_unit(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.submit(), range(16)))
        self.assertEqual(len({r['receipt']['admission_id'] for r in results}), 1)
        with self.db._read_ctx() as conn:
            self.assertEqual(conn.execute('SELECT spent FROM stellar_bg_bindings_v1').fetchone()[0], 1)

    def test_separate_database_handles_serialize_payload_conflict(self):
        from hermes_state import SessionDB
        from stellar_background import Ledger, ContractError
        barrier = threading.Barrier(2)
        def submit_from_connection(value):
            db = SessionDB(self.path)
            try:
                ledger = Ledger(db, producer_id='stellar-herdr', profile_id='fixture-ivy',
                                gate=self.gate, clock=lambda: self.now)
                barrier.wait(timeout=10)
                try:
                    return ledger.submit(self.binding['bindingId'], self.event(fact={'head': value}), epoch=self.epoch)['status']
                except ContractError as exc:
                    return exc.code
            finally:
                db.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit_from_connection, ['left', 'right']))
        self.assertCountEqual(results, ['admitted', 'conflict'])
        self.assertEqual(self.counts(), (1, 1))

    def test_separate_database_handles_order_effect_reservation_against_revocation(self):
        from hermes_state import SessionDB
        from stellar_background import Ledger, ContractError
        self.submit(); self.complete()
        barrier = threading.Barrier(2)
        def run(operation):
            db = SessionDB(self.path)
            try:
                ledger = Ledger(db, producer_id='stellar-herdr', profile_id='fixture-ivy',
                                gate=self.gate, clock=lambda: self.now)
                barrier.wait(timeout=10)
                if operation == 'revoke':
                    return ledger.revoke(self.binding['bindingId'])
                try:
                    return ledger.begin_effect(self.binding['bindingId'], 'event-1', self.digest(self.event()),
                        client='c', operation='o', kind='speech')
                except ContractError as exc:
                    return {'error': exc.code}
            finally:
                db.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            effect, revoked = list(pool.map(run, ['effect', 'revoke']))
        if effect.get('execute') is True:
            self.assertEqual(revoked['status'], 'revoking')
            self.assertFalse(revoked['effectsStopped'])
        else:
            self.assertEqual(effect, {'error': 'consent_unavailable'})
            self.assertEqual(revoked['status'], 'revoked')
            self.assertTrue(revoked['effectsStopped'])

    def test_transaction_failure_rolls_back_event_budget_and_admission(self):
        original = self.db._execute_write
        def fail_after_write(func):
            def write(conn):
                func(conn)
                raise RuntimeError('injected before owning transaction commit')
            return original(write)
        with patch.object(self.db, '_execute_write', side_effect=fail_after_write):
            with self.assertRaises(RuntimeError):
                self.submit()
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.submit()['status'], 'admitted')

    def test_backpressure_refuses_before_event_identity_is_reserved(self):
        for n in range(16):
            self.submit(self.event(str(n)))
        self.assertCode('not_admitted_busy', lambda: self.submit(self.event('overflow')))
        self.assertEqual(self.counts(), (16, 16))
        unknown = self.ledger.inspect(self.binding['bindingId'], 'overflow', self.digest(self.event('overflow')))
        self.assertEqual(unknown['status'], 'unknown')
        self.assertFalse(unknown['retryAuthorized'])

    def test_retained_binding_capacity_never_deletes_revoked_replay_fences(self):
        self.ledger.revoke(self.binding['bindingId'])
        for revision in range(2, 21):
            self.ledger.bind(self.origin, consent_revision=revision, expires_at=self.now + 1000, max_admissions=1)
        self.assertCode('binding_capacity', lambda: self.ledger.bind(self.origin, consent_revision=21,
            expires_at=self.now + 1000, max_admissions=1))
        with self.db._read_ctx() as conn:
            self.assertTrue(self.ledger._get(conn, self.binding['bindingId'])['revoked'])

    def test_explicit_budget_and_expiry_do_not_create_unbounded_grants(self):
        self.assertCode('invalid_params', lambda: self.ledger.bind(self.origin, consent_revision=1,
            expires_at=self.now + 1000, max_admissions=0))
        self.assertCode('invalid_params', lambda: self.ledger.bind(self.origin, consent_revision=1,
            expires_at=self.now + 8 * 86400_000, max_admissions=1))
        self.db._execute_write(lambda conn: conn.execute('UPDATE stellar_bg_bindings_v1 SET maximum=1'))
        self.submit()
        self.assertCode('budget_exhausted', lambda: self.submit(self.event('second')))
        self.now += 600_001
        self.assertCode('consent_unavailable', self.submit)

    def test_stale_or_future_event_and_multibyte_limits_fail_before_admission(self):
        from stellar_background.contract import MAX_ENVELOPE_BYTES
        self.assertCode('invalid_params', lambda: self.submit(self.event('😀' * 65)))
        self.assertCode('invalid_params', lambda: self.submit(self.event(fact='é' * MAX_ENVELOPE_BYTES)))
        future = self.event(); future['payload']['observedAt'] += 1
        self.assertCode('event_expired', lambda: self.submit(future))
        old = self.event(); self.now += 300_001
        self.assertCode('event_expired', lambda: self.submit(old))
        self.assertEqual(self.counts(), (0, 0))

    def test_wrong_profile_producer_target_and_provider_absence_fail_closed(self):
        from stellar_background import Ledger
        other = Ledger(self.db, producer_id='stellar-herdr', profile_id='other', gate=self.gate, clock=lambda: self.now)
        self.assertCode('permission_denied', lambda: other.inspect(self.binding['bindingId'], 'event-1', 'a' * 64))
        self.assertCode('permission_denied', lambda: self.ledger.bind(replace(self.origin, producerId='forged'),
            consent_revision=1, expires_at=self.now + 1000, max_admissions=1))
        self.submit()
        self.host_available = False
        self.assertCode('binding_changed', self.claim)
        self.assertFalse(self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))['deliveryAuthorized'])

    def test_reset_or_compression_boundary_prevents_claim(self):
        self.submit()
        self.db.end_session('original', end_reason='compression')
        self.db.create_session('new-tip', source='local', parent_session_id='original')
        self.assertCode('binding_changed', self.claim)
        self.assertCode('binding_changed', lambda: self.submit(self.event('new')))

    def test_forged_marker_is_rejected_but_user_quotation_is_ordinary_input(self):
        from hermes_state_runtime import admit_session_input
        human = admit_session_input(self.db, epoch=self.epoch, principal_id='fixture-human',
            session_id='original', request_id='human', payload={'text': 'lifecycle_update process_complete'})
        with self.db._read_ctx() as conn:
            self.ledger.guard_claim(conn, human)
        forged = {**human, 'payload': {'local_automation_v1': {'background_v1': {'schemaVersion': 1}}}}
        with self.db._read_ctx() as conn:
            self.assertCode('untrusted_descriptor', lambda: self.ledger.guard_claim(conn, forged))

    def test_revoke_before_claim_cancels_only_its_own_canonical_queue(self):
        from hermes_state_runtime import admit_session_input, get_session_admission
        first = self.submit()
        # Request IDs are unique only with principal + target. A quoted/public ID grants no cancellation authority.
        request = self.ledger._request(self.binding['bindingId'], 'event-1')
        human = admit_session_input(self.db, epoch=self.epoch, principal_id='fixture-human',
            session_id='original', request_id=request, payload={'text': 'ordinary foreground'})
        revoked = self.ledger.revoke(self.binding['bindingId'])
        self.assertEqual(revoked['status'], 'revoked')
        self.assertEqual(get_session_admission(self.db, admission_id=human['admission_id'])['status'], 'queued')
        query = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertEqual(query['receipt']['admission_id'], first['receipt']['admission_id'])
        self.assertEqual(query['receipt']['outcome'], 'cancelled')
        self.assertFalse(query['deliveryAuthorized'])

    def test_host_source_outage_and_mutating_caller_payload_do_not_admit_stale_hash(self):
        from stellar_background import Ledger
        failed = Ledger(self.db, producer_id='stellar-herdr', profile_id='fixture-ivy',
            gate=lambda *_: (_ for _ in ()).throw(OSError('private path must not escape')), clock=lambda: self.now)
        self.assertCode('host_unavailable', lambda: failed.submit(self.binding['bindingId'], self.event(), epoch=self.epoch))
        caller = self.event()
        original = self.ledger.gate
        def mutate(conn, binding):
            caller['payload']['fact'] = {'head': 'mutated by caller during host gate'}
            return original(conn, binding)
        self.ledger.gate = mutate
        result = self.submit(caller)
        expected = self.event()
        self.assertEqual(result['descriptor']['digest'], self.digest(expected))
        self.assertEqual(self.counts(), (1, 1))

    def test_revocation_does_not_certify_effect_stop_until_exact_owner_ack(self):
        self.submit(); self.complete()
        arguments = dict(client='fixture-consumer', operation='durable-speech-1', kind='speech')
        effect = lambda: self.ledger.begin_effect(self.binding['bindingId'], 'event-1', self.digest(self.event()), **arguments)
        self.assertTrue(effect()['execute'])
        self.assertEqual(effect(), {'status': 'unknown', 'execute': False})
        revoked = self.ledger.revoke(self.binding['bindingId'])
        self.assertEqual(revoked['status'], 'revoking')
        self.assertFalse(revoked['effectsStopped'])
        self.assertCode('consent_unavailable', effect)
        self.now += 8 * 86400_000  # elapsed time does not release a lost effect owner
        self.assertFalse(self.ledger.revoke(self.binding['bindingId'])['effectsStopped'])
        self.assertCode('effect_owner_mismatch', lambda: self.ledger.finish_effect(self.binding['bindingId'],
            'event-1', **{**arguments, 'client': 'other'}))
        finished = self.ledger.finish_effect(self.binding['bindingId'], 'event-1', **arguments)
        self.assertTrue(finished['effectsStopped'])

    def test_revocation_during_execution_prevents_completed_settlement(self):
        from hermes_state_runtime import settle_session_input
        self.submit(); started = self.claim()
        self.ledger.revoke(self.binding['bindingId'])
        self.assertCode('consent_unavailable', lambda: settle_session_input(self.db, epoch=self.epoch,
            admission_id=started['admission_id'], generation=started['generation'], outcome='completed',
            result={'result': {'final_response': 'must not commit as completed'}},
            _terminal_write=lambda conn, row: self.ledger.guard_terminal(conn, row)))
        result = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertFalse(result['deliveryAuthorized'])
        self.assertNotEqual(result['receipt']['status'], 'terminal')

    def test_missing_admission_is_unknown_and_never_executed_again(self):
        self.submit()
        self.db._execute_write(lambda conn: conn.execute('DELETE FROM session_admissions'))
        self.assertEqual(self.submit()['status'], 'unknown')
        self.assertEqual(self.counts(), (1, 0))

    def test_empty_or_whitespace_note_does_not_authorize_an_effect(self):
        for index, response in enumerate(('', ' \n\t')):
            event = self.event(str(index))
            self.submit(event); self.complete(response)
            self.assertCode('result_unavailable', lambda: self.ledger.begin_effect(self.binding['bindingId'],
                event['eventId'], self.digest(event), client='c', operation='o', kind='render'))

    def test_host_settlement_port_records_revoked_turn_as_interrupted_without_answer(self):
        self.submit(); started = self.claim()
        self.ledger.revoke(self.binding['bindingId'])
        result = self.ledger.settle(epoch=self.epoch, admission_id=started['admission_id'],
            generation=started['generation'], result={'result': {'final_response': 'suppressed fixture'}})
        self.assertEqual(result['outcome'], 'interrupted')
        receipt = self.ledger.inspect(self.binding['bindingId'], 'event-1', self.digest(self.event()))
        self.assertFalse(receipt['deliveryAuthorized'])
        self.assertEqual(receipt['receipt']['result']['final_response'], '')

    def test_failed_malformed_or_oversized_canonical_result_is_not_deliverable(self):
        from hermes_state_runtime import settle_session_input
        from stellar_background.contract import MAX_RESULT_BYTES
        for index, inner in enumerate((None, [], 42, 'failure', {'final_response': '😀' * (MAX_RESULT_BYTES // 4 + 1)})):
            event = self.event(str(index))
            self.submit(event); started = self.claim()
            settle_session_input(self.db, epoch=self.epoch, admission_id=started['admission_id'],
                generation=started['generation'], outcome='failed', result={'result': inner},
                _terminal_write=lambda conn, row: self.ledger.guard_terminal(conn, row))
            receipt = self.ledger.inspect(self.binding['bindingId'], event['eventId'], self.digest(event))
            self.assertEqual(receipt['status'], 'terminal')
            self.assertFalse(receipt['deliveryAuthorized'])
            self.assertNotIn('result', receipt['receipt'])
            self.assertCode('result_unavailable', lambda: self.ledger.begin_effect(self.binding['bindingId'],
                event['eventId'], self.digest(event), client='c', operation='o', kind='render'))

    def test_contract_rejects_extra_authority_fields_and_noncanonical_values(self):
        for extra in ('display_kind', 'actor', 'authority_epoch', 'autonomous'):
            self.assertCode('invalid_params', lambda: self.submit({**self.event(), extra: True}))
        self.assertCode('invalid_params', lambda: self.submit(self.event(fact={'value': float('nan')})))
        self.assertCode('invalid_params', lambda: self.submit({**self.event(), 'schemaVersion': True}))
        self.assertEqual(self.counts(), (0, 0))

    def test_retry_budget_is_bounded_and_unknown_is_not_retry_authority(self):
        from stellar_background.contract import retry_delay
        self.assertIsNone(retry_delay(1, guaranteed_not_admitted=False, now=0, expires_at=100_000))
        self.assertEqual([retry_delay(i, guaranteed_not_admitted=True, now=0, expires_at=100_000)
                          for i in range(1, 9)], [1, 2, 4, 8, 16, 30, 30, None])
        self.assertIsNone(retry_delay(1, guaranteed_not_admitted=True, now=0, expires_at=1000))

    def test_pin_verification_is_not_activation_and_modified_source_refuses(self):
        from stellar_background.provenance import verify_runtime
        runtime = Path(RUNTIME)
        actual = verify_runtime(runtime)
        self.assertFalse(actual['installedCapability'])
        staged = Path(self.tmp.name) / 'pin-fixture'
        pin_path = REPO / 'config/hermes-compat/stellar-background-v1/runtime-pin.json'
        pin = json.loads(pin_path.read_text(encoding='utf-8'))
        for name in [*pin['files'], 'install-stamp.json']:
            dest = staged / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(runtime / name, dest)
        self.assertEqual(verify_runtime(staged), actual)
        (staged / 'hermes_state_runtime.py').write_text('# unknown update\n', encoding='utf-8')
        self.assertCode('runtime_mismatch', lambda: verify_runtime(staged))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    args, remaining = parser.parse_known_args()
    RUNTIME = args.runtime.resolve()
    # Imports see only a disposable home; no bootstrap, model, live session or network is used.
    with tempfile.TemporaryDirectory(prefix='stellar339-candidate-home-') as home:
        for key in ('HERMES_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'):
            os.environ[key] = home
        sys.dont_write_bytecode = True
        sys.path[:0] = [str(REPO / 'config/hermes-compat/stellar-background-v1'), str(args.runtime.resolve())]
        unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
