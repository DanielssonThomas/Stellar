import sqlite3
from unittest.mock import patch
from .fixtures import Fixture
import journal_v3 as journal
from journal_v3.schema import ATTEMPT


class CommitFault:
    def __init__(self, conn, after=False, message='database is locked'):
        self.conn, self.after, self.message, self.used = conn, after, message, False

    def __getattr__(self, name): return getattr(self.conn, name)

    def commit(self):
        if self.used: return self.conn.commit()
        self.used = True
        if self.after: self.conn.commit()
        raise sqlite3.OperationalError(self.message)


class WriterFailureTests(Fixture):
    def test_actual_writer_callback_busy_locked_and_no_rows_enter_only_once(self):
        for error in [sqlite3.OperationalError('database is locked'),
            sqlite3.OperationalError('database table is locked'), sqlite3.InterfaceError('no more rows available')]:
            calls = []
            def callback(conn):
                calls.append(1); journal.reserve_on(conn, self.context, self.scope, self.now); raise error
            with patch.object(self.db, '_sleep_before_write_retry', return_value=True):
                self.assertCode('write_uncertain', lambda: self.write(callback))
            self.assertEqual(len(calls), 1)
            self.assertEqual(self.raw_count(ATTEMPT), 0)

    def test_commit_busy_before_commit_never_reenters_journal_body(self):
        self.commit_fault(after=False)

    def test_commit_then_busy_is_unknown_but_retains_profile_latch(self):
        self.commit_fault(after=True)
        self.reopen()
        self.assertEqual(self.inspect()['phase'], 'pending')
        self.assertCode('consent_uncertain', self.reserve)

    def commit_fault(self, after):
        calls = []
        original = self.db._conn
        self.db._conn = CommitFault(original, after=after)
        def callback(conn):
            calls.append(1); return journal.reserve_on(conn, self.context, self.scope, self.now)
        try:
            with patch.object(self.db, '_sleep_before_write_retry', return_value=True):
                self.assertCode('write_uncertain', lambda: self.write(callback))
        finally: self.db._conn = original
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.raw_count(ATTEMPT), int(after))

    def test_actual_fresh_bind_hook_is_one_shot_on_post_commit_retry(self):
        self.ready()
        original = self.db._conn
        self.db._conn = CommitFault(original, after=True)
        try:
            with patch.object(self.db, '_sleep_before_write_retry', return_value=True):
                self.assertCode('write_uncertain', self.bind)
        finally: self.db._conn = original
        self.assertEqual(self.inspect()['phase'], 'bound')
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 1)
        self.assertEqual(self.raw_count('stellar_bg_owners_v1'), 1)

    def test_external_lost_ack_does_not_mean_cancellation_or_bind_was_rolled_back(self):
        self.ready(); self.bind()
        def lost_ack():
            self.cancel(); raise ConnectionError('synthetic lost post-commit ACK')
        with self.assertRaises(ConnectionError): lost_ack()
        self.reopen()
        self.assertEqual(self.inspect()['deny_requested'], 1)
        self.assertEqual(self.db._conn.execute('SELECT revoked FROM stellar_bg_bindings_v1').fetchone()[0], 1)
        self.assertCode('consent_uncertain', self.bind)
