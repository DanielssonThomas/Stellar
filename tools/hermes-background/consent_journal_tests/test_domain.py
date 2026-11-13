import copy
from .fixtures import Fixture
import journal_v3 as journal
from journal_v3.validation import unpack, pack_context, pack_prepared
from journal_v3.schema import TRIGGERS, ATTEMPT


class DomainTests(Fixture):
    def test_sequence_hash_only_owner_and_no_reconstruction_after_reopen(self):
        for operation, phase in [(self.reserve, 'pending'), (self.begin, 'confirming'),
            (self.issue, 'issuing'), (self.ticket, 'issued'), (self.release, 'issued'), (self.bind, 'bound')]:
            operation()  # Simulate losing only the post-commit external ACK.
            self.reopen()
            row = self.inspect()
            self.assertEqual(row['phase'], phase)
            self.assertNotIn('ticket', row)
            self.assertNotIn('consentTicket', row)
            self.assertCode('consent_uncertain', self.reserve)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 1)
        self.assertEqual(self.raw_count('stellar_bg_owners_v1'), 1)
        self.assertCode('consent_uncertain', self.bind)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 1)

    def test_cancel_before_and_after_issue_never_releases_profile_latch(self):
        self.reserve(); self.begin()
        self.assertEqual(self.cancel(), 'cancelled_before_issue')
        self.assertEqual(self.cancel(), 'cancelled_before_issue')
        self.assertCode('consent_uncertain', self.issue)
        self.context = self.changed_context(launchId='0' * 32, attachmentId='0' * 64, authorityEpoch=self.epoch + 1)
        self.scope = self.changed_scope(); self.scope['challengeId'] = '0' * 64
        self.assertCode('consent_uncertain', self.reserve)

    def test_issuance_cancel_fence_prevents_ticket_release_and_bind(self):
        self.reserve(); self.begin(); self.issue()
        self.assertEqual(self.cancel(), 'uncertain_revoking')
        self.assertCode('consent_uncertain', self.ticket)
        self.assertEqual(self.inspect()['phase'], 'issuing')
        self.assertEqual(self.inspect()['deny_requested'], 1)

    def test_no_repeated_issue_ticket_release_and_missing_ticket_is_unknown(self):
        self.reserve(); self.begin(); self.issue()
        self.reopen()
        self.assertIsNone(self.inspect()['ticket_hash'])
        self.assertCode('consent_uncertain', self.issue)
        self.ticket(); self.release()
        self.assertCode('consent_uncertain', self.ticket)
        self.assertCode('consent_uncertain', self.release)

    def test_context_and_all_original_scope_fields_cannot_change(self):
        self.reserve()
        for key, value in [('launchId', '0' * 32), ('attachmentId', '0' * 64),
            ('ownerSubject', 'other-owner'), ('authorityEpoch', self.epoch + 1),
            ('connectionGeneration', 2), ('policyDigest', '0' * 64)]:
            self.assertCode('context_changed', lambda: self.write(lambda conn: journal.begin_on(conn,
                self.challenge, self.changed_context(**{key: value}), self.now)))
        self.assertEqual(self.inspect()['phase'], 'pending')

    def test_invalid_shapes_unsafe_types_duplicate_json_and_bounds_refuse(self):
        for bad in [[], {**self.context, 'extra': True}, {**self.context, 'authorityEpoch': True},
            {**self.context, 'profileId': 'other'}, {**self.context, 'ownerSubject': '\u200b'}]:
            with self.assertRaises(journal.JournalError): pack_context(bad)
        for change in [lambda x: x.update(maxAdmissions=True), lambda x: x.update(challengeExpiresAt=self.now),
            lambda x: x.update(challengeExpiresAt=self.now + 60001), lambda x: x.update(origin=[]),
            lambda x: x.update(displayScope=[]), lambda x: x['origin'].update(route='route with spaces')]:
            bad = copy.deepcopy(self.scope); change(bad)
            with self.assertRaises(journal.JournalError): pack_prepared(bad, self.now)
        for text in ['{"x":1,"x":1}', '{"x":1.0}', '{"x":NaN}', '{ "x":1}', '[true]']:
            if text == '[true]':
                with self.assertRaises(journal.JournalError): pack_context(unpack(text, 8192))
            else:
                with self.assertRaises(journal.JournalError): unpack(text, 8192)

    def test_db_row_corruption_is_not_repaired_or_trusted(self):
        self.reserve()
        self.db._conn.execute('DROP TRIGGER stellar_nc_attempt_identity_v3')
        self.db._conn.execute(f'UPDATE main.{ATTEMPT} SET prepared_digest=?', ('0' * 64,))
        sql = next(sql for name, _, sql in TRIGGERS if name == 'stellar_nc_attempt_identity_v3')
        self.db._conn.execute(sql)
        self.assertCode('journal_corrupt', lambda: self.write(journal.verify_on))

    def test_fresh_time_backwards_and_expired_ticket_refuse(self):
        self.reserve()
        with self.assertRaises(journal.JournalError):
            self.write(lambda conn: journal.begin_on(conn, self.challenge, self.context, self.now - 1))
        self.begin(); self.issue()
        with self.assertRaises(journal.JournalError): self.ticket(deadline=self.now)
        self.ticket(); self.release(); self.now += 30000
        self.assertCode('consent_expired', self.bind)
        self.assertEqual(self.raw_count('stellar_bg_bindings_v1'), 0)
