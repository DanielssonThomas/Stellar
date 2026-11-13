import copy
from pathlib import Path
import tempfile
import unittest

import journal_v3 as journal


class Fixture(unittest.TestCase):
    initialize_journal = True

    def setUp(self):
        from hermes_state import SessionDB
        from hermes_state_runtime import begin_runtime_epoch
        from stellar_background import Ledger, Origin
        from stellar_background.schema import install_schema
        self.tmp = tempfile.TemporaryDirectory(prefix='stellar339-consent-')
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'canonical.db'
        self.db = SessionDB(self.path)
        self.addCleanup(self.db.close)
        self.db.create_session('original', source='local')
        install_schema(self.db)
        self.epoch = begin_runtime_epoch(self.db, instance_id='journal-only-fixture')
        self.configure(self.db)

        self.now = 1700000000000
        self.origin = Origin('ivy', 'original', 'original', 'fixture-route', 'stellar-herdr', 'f' * 32)
        self.ledger = Ledger(journal.OneShotWriter(self.db), producer_id='stellar-herdr', profile_id='ivy',
            gate=lambda conn, binding: binding['origin'] == self.origin.__dict__, clock=lambda: self.now)
        self.context = {'profileId': 'ivy', 'launchId': 'b' * 32, 'attachmentId': 'c' * 64,
            'ownerSubject': 'synthetic-native-owner', 'authorityEpoch': self.epoch,
            'connectionGeneration': 1, 'policyDigest': 'd' * 64}
        self.scope = {'version': 1, 'challengeId': 'a' * 64, 'connectionBinding': 'e' * 64,
            'origin': self.origin.__dict__, 'displayScope': {'profileLabel': 'Fixture Ivy',
                'conversationLabel': 'Disposable session', 'producerLabel': 'Fixture Stellar',
                'effects': ['render', 'speech']}, 'expiresAt': self.now + 600000,
            'challengeExpiresAt': self.now + 60000, 'maxAdmissions': 8}
        self.challenge = self.scope['challengeId']
        self.intent, self.ticket_hash = 'b1' * 32, 'a1' * 32  # Hash/IDs only, no issued ticket.
        if self.initialize_journal:
            self.write(journal.migrate_on)

    @staticmethod
    def configure(db):
        # These settings apply ONLY to this newly created disposable database.
        db._conn.execute('PRAGMA synchronous=FULL')
        db._conn.execute('PRAGMA recursive_triggers=ON')

    def write(self, callback):
        return journal.write_once(self.db, callback)

    def inspect(self):
        return self.write(lambda conn: journal.inspect_on(conn, self.challenge))

    def reserve(self):
        return self.write(lambda conn: journal.reserve_on(conn, self.context, self.scope, self.now))

    def begin(self):
        return self.write(lambda conn: journal.begin_on(conn, self.challenge, self.context, self.now))

    def issue(self):
        return self.write(lambda conn: journal.reserve_issue_on(conn, self.challenge, self.context, self.intent, self.now))

    def ticket(self, deadline=None):
        return self.write(lambda conn: journal.record_ticket_on(conn, self.challenge, self.context,
            self.intent, self.ticket_hash, self.now + 30000 if deadline is None else deadline, self.now))

    def release(self):
        return self.write(lambda conn: journal.reserve_release_on(conn, self.challenge, self.context, self.now))

    def ready(self):
        self.reserve(); self.begin(); self.issue(); self.ticket(); self.release()

    def bind(self, ledger=None, callback=None):
        hook = journal.once(callback or (lambda conn, binding: journal.consume_binding_on(conn, self.challenge,
            self.context, self.ticket_hash, binding, self.now)))
        return (ledger or self.ledger).bind(self.origin, consent_revision=1,
            expires_at=self.scope['expiresAt'], max_admissions=self.scope['maxAdmissions'], _on_bind=hook)

    def cancel(self, hook=None):
        return self.write(lambda conn: journal.cancel_on(conn, self.challenge, self.context,
            revoke_binding_on=self.ledger._revoke_on if hook is None else hook))

    def reopen(self):
        from hermes_state import SessionDB
        self.db.close()
        self.db = SessionDB(self.path)
        self.addCleanup(self.db.close)
        self.configure(self.db)
        self.ledger.db = journal.OneShotWriter(self.db)

    def add_retained_work(self, binding):
        from hermes_state_runtime import claim_session_input
        for event_id in ('started-fixture', 'queued-fixture'):
            self.ledger.submit(binding['bindingId'], {'schemaVersion': 1, 'eventId': event_id,
                'kind': 'lifecycle_update', 'payload': {'milestone': 'waiting_review',
                'fact': {'fixture': True}, 'observedAt': self.now}}, epoch=self.epoch)
        started = claim_session_input(self.db, epoch=self.epoch, session_id='original')
        self.db._execute_write(lambda conn: conn.execute('INSERT INTO stellar_bg_effects_v1 VALUES(?,?,?,?,?,0)',
            (binding['bindingId'], 'started-fixture', 'speech', 'synthetic-client', 'retained-fixture-only')))
        return started

    def assertCode(self, code, callback):
        with self.assertRaises(journal.JournalError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def changed_context(self, **values):
        return {**self.context, **values}

    def changed_scope(self):
        return copy.deepcopy(self.scope)

    def raw_count(self, table):
        return self.db._conn.execute('SELECT count(*) FROM main.' + table).fetchone()[0]


class ExecuteFault:
    def __init__(self, conn, after):
        self.conn, self.after, self.count = conn, after, 0

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def execute(self, sql, *args):
        result = self.conn.execute(sql, *args)
        if sql.startswith(('CREATE TABLE', 'CREATE TRIGGER', 'INSERT INTO main.stellar_nc_meta_v3')):
            self.count += 1
            if self.count == self.after:
                raise RuntimeError('synthetic after-DDL fault')
        return result
