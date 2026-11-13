"""Real threads/writer; every connection and ticket remains synthetic DATA."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event, current_thread
from unittest.mock import patch

import journal_v3 as journal
from .host_fixtures import HostFixture


class HostConcurrencyTests(HostFixture):
    def blocked_successor(self, predecessor, successor, *, after_commit=False):
        entered, resume = Event(), Event()
        execute = self.db._execute_write
        writes = []
        def blocked(callback):
            writes.append(1)
            if after_commit:
                result = execute(callback)
            entered.set()
            if not resume.wait(10): raise RuntimeError('fixture synchronization timeout')
            if after_commit:
                raise ConnectionError('synthetic committed result lost')
            return execute(callback)
        with patch.object(self.db, '_execute_write', blocked), ThreadPoolExecutor(1) as pool:
            pending = pool.submit(predecessor)
            try:
                self.assertTrue(entered.wait(10))
                self.assertCode('consent_uncertain', successor)
                self.assertEqual(len(writes), 1)
            finally: resume.set()
            with self.assertRaises((journal.JournalError, ConnectionError)):
                pending.result(timeout=10)
        self.assertTrue(self.plan._uncertain)
        self.assertCode('consent_uncertain', successor)

    def test_begin_cannot_enter_while_reserve_waits(self):
        self.blocked_successor(lambda: self.call('reserve'), lambda: self.call('begin'))
        self.assertEqual(self.raw_count('stellar_nc_attempt_v3'), 0)

    def test_begin_cannot_enter_after_reserve_commit_but_unknown_result(self):
        self.blocked_successor(lambda: self.call('reserve'), lambda: self.call('begin'), after_commit=True)
        self.assertEqual(self.inspect()['phase'], 'pending')

    def test_ticket_cannot_enter_while_issue_waits(self):
        self.prepare_host('confirming')
        self.blocked_successor(lambda: self.call('reserve_issue', self.intent),
            lambda: self.call('record_ticket', self.intent, self.ticket_data_fixture, self.now + 10000))
        self.assertEqual(self.inspect()['phase'], 'confirming')

    def test_ticket_cannot_enter_after_issue_commit_but_unknown_result(self):
        self.prepare_host('confirming')
        self.blocked_successor(lambda: self.call('reserve_issue', self.intent),
            lambda: self.call('record_ticket', self.intent, self.ticket_data_fixture, self.now + 10000),
            after_commit=True)
        self.assertEqual(self.inspect()['phase'], 'issuing')
        self.assertIsNone(self.inspect()['ticket_hash'])

    def test_bind_cannot_enter_while_release_waits(self):
        self.prepare_host('issued')
        self.blocked_successor(lambda: self.call('release'), self.bind_host)
        self.assertEqual(self.inspect()['release_reserved'], 0)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)

    def test_bind_cannot_enter_after_release_commit_but_unknown_result(self):
        self.prepare_host('issued')
        self.blocked_successor(lambda: self.call('release'), self.bind_host, after_commit=True)
        self.assertEqual(self.inspect()['release_reserved'], 1)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)

    def cancel_race(self, *, after_bind_commit):
        self.prepare_host()
        entered, resume = Event(), Event()
        execute = self.db._execute_write
        positive_thread = None
        def blocked(callback):
            nonlocal positive_thread
            if current_thread() is positive_thread:
                result = execute(callback) if after_bind_commit else None
                entered.set()
                if not resume.wait(10): raise RuntimeError('fixture synchronization timeout')
                return result if after_bind_commit else execute(callback)
            return execute(callback)
        def positive():
            nonlocal positive_thread
            positive_thread = current_thread()
            return self.bind_host()
        with patch.object(self.db, '_execute_write', blocked), ThreadPoolExecutor(1) as pool:
            pending = pool.submit(positive)
            try:
                self.assertTrue(entered.wait(10))
                self.assertEqual(self.cancel_host(), 'uncertain_revoking')
            finally: resume.set()
            self.assertCode('consent_uncertain', lambda: pending.result(timeout=10))
        self.assertEqual(self.inspect()['deny_requested'], 1)
        rows = self.db._conn.execute('SELECT revoked FROM stellar_bg_bindings_v1').fetchall()
        self.assertEqual(len(rows), int(after_bind_commit))
        self.assertTrue(all(row[0] == 1 for row in rows))
        self.assertCode('consent_uncertain', self.bind_host)

    def test_cancel_before_blocked_bind_writer_refuses_bind(self):
        self.cancel_race(after_bind_commit=False)

    def test_cancel_after_bind_commit_before_reply_revokes_and_withholds_bind_result(self):
        self.cancel_race(after_bind_commit=True)
