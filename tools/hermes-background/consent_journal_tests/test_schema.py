import sqlite3
from .fixtures import Fixture, ExecuteFault
import journal_v3 as journal
from journal_v3.schema import ATTEMPT, META, catalog, DIGEST, TABLES, TRIGGERS


class SchemaTests(Fixture):
    initialize_journal = False

    def test_explicit_creation_noop_and_no_transaction_refusal(self):
        old = self.raw_count('sessions')
        self.write(journal.migrate_on)
        self.write(journal.migrate_on)
        self.assertEqual(self.raw_count('sessions'), old)
        self.assertEqual(self.raw_count(ATTEMPT), 0)
        self.assertEqual(self.db._conn.execute(f'SELECT schema_digest FROM main.{META}').fetchone()[0], DIGEST)
        self.assertCode('transaction_required', lambda: journal.verify_on(self.db._conn))

    def test_every_ddl_fault_rolls_back_without_erasing_existing_canonical_rows(self):
        for step in range(1, 11):
            with self.assertRaisesRegex(RuntimeError, 'after-DDL'):
                self.write(lambda conn: journal.migrate_on(ExecuteFault(conn, step)))
            self.assertEqual(catalog(self.db._conn), {})
            self.assertEqual(self.raw_count('sessions'), 1)
        self.write(journal.migrate_on)

    def test_partial_unknown_extra_objects_and_literal_changes_refuse(self):
        self.db._conn.execute('CREATE TABLE stellar_nc_unknown_v3(x)')
        self.assertCode('schema_mismatch', lambda: self.write(journal.migrate_on))
        self.db._conn.execute('DROP TABLE stellar_nc_unknown_v3')
        self.write(journal.migrate_on)
        self.db._conn.execute(f'CREATE INDEX extra_index ON {ATTEMPT}(phase)')
        self.assertCode('schema_mismatch', lambda: self.write(journal.verify_on))

    def test_uppercase_and_mixed_case_unknown_namespace_are_not_ignored(self):
        for name in ('STELLAR_NC_UNKNOWN_V3', 'StElLaR_Nc_Unknown_V3'):
            self.db._conn.execute(f'CREATE TABLE {name}(x)')
            self.assertCode('schema_mismatch', lambda: self.write(journal.migrate_on))
            self.db._conn.execute(f'DROP TABLE {name}')
        self.write(journal.migrate_on)

    def test_temp_shadow_trigger_and_attached_database_refuse(self):
        for sql, cleanup in [
            ('CREATE TEMP TABLE stellar_bg_bindings_v1(x)', 'DROP TABLE temp.stellar_bg_bindings_v1'),
            ('CREATE TEMP TRIGGER shadow AFTER UPDATE ON main.stellar_bg_bindings_v1 BEGIN SELECT 1; END',
             'DROP TRIGGER temp.shadow'),
            ("ATTACH DATABASE ':memory:' AS alien", 'DETACH DATABASE alien'),
        ]:
            self.db._conn.execute(sql)
            self.assertCode('schema_environment', lambda: self.write(journal.migrate_on))
            self.assertEqual(catalog(self.db._conn), {})
            self.db._conn.execute(cleanup)

    def test_unsafe_settings_refuse_and_are_never_changed_by_journal(self):
        for key, bad, good in [('recursive_triggers', 0, 1), ('ignore_check_constraints', 1, 0),
                               ('writable_schema', 1, 0), ('synchronous', 1, 2)]:
            self.db._conn.execute(f'PRAGMA {key}={bad}')
            self.assertCode('schema_environment', lambda: self.write(journal.migrate_on))
            self.assertEqual(self.db._conn.execute(f'PRAGMA {key}').fetchone()[0], bad)
            self.db._conn.execute(f'PRAGMA {key}={good}')

    def test_wrong_version_and_missing_trigger_are_not_repaired(self):
        self.write(journal.migrate_on)
        self.db._conn.execute('DROP TRIGGER stellar_nc_meta_immutable_v3')
        self.assertCode('schema_mismatch', lambda: self.write(journal.migrate_on))
        self.assertEqual(self.db._conn.execute("SELECT count(*) FROM main.sqlite_schema WHERE name='stellar_nc_meta_immutable_v3'").fetchone()[0], 0)

    def test_hidden_view_cross_table_trigger_and_prerequisite_view_refuse(self):
        self.write(journal.migrate_on)
        for sql, cleanup in [
            ('CREATE VIEW unrelated_view AS SELECT * FROM "StElLaR_Nc_AtTeMpT_V3"', 'DROP VIEW unrelated_view'),
            ('CREATE TRIGGER elsewhere AFTER UPDATE ON sessions BEGIN UPDATE stellar_nc_attempt_v3 SET deny_requested=1; END',
             'DROP TRIGGER elsewhere'),
        ]:
            self.db._conn.execute(sql)
            self.assertCode('schema_mismatch', lambda: self.write(journal.verify_on))
            self.db._conn.execute(cleanup)
        self.db._conn.execute('DROP TABLE stellar_bg_owners_v1')
        self.db._conn.execute('CREATE VIEW stellar_bg_owners_v1 AS SELECT NULL AS binding_id,NULL AS subject')
        self.assertCode('canonical_schema', lambda: self.write(journal.verify_on))

    def test_hex_check_rejects_nul_suffix_in_actual_fresh_table(self):
        self.write(lambda conn: conn.execute(TABLES[0][1]))
        for bad in ['a' * 64 + '\0bad', 'a' * 63 + '\0', 'A' * 64]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.write(lambda conn: conn.execute(f'INSERT INTO main.{META} VALUES(1,3,?,0)', (bad,)))
            self.assertEqual(self.raw_count(META), 0)
        self.write(lambda conn: conn.execute(f'INSERT INTO main.{META} VALUES(1,3,?,0)', (DIGEST,)))
        self.assertEqual(self.raw_count(META), 1)

    def test_fingerprint_preserves_trigger_literal_case_and_rejects_version_data(self):
        self.write(journal.migrate_on)
        name = 'stellar_nc_meta_nodelete_v3'
        sql = next(sql for key, _, sql in TRIGGERS if key == name)
        self.db._conn.execute('DROP TRIGGER ' + name)
        self.db._conn.execute(sql.replace('consent history retained', 'Consent history retained'))
        self.assertCode('schema_mismatch', lambda: self.write(journal.verify_on))
        self.db._conn.execute('DROP TRIGGER ' + name); self.db._conn.execute(sql)
        name = 'stellar_nc_meta_immutable_v3'
        sql = next(sql for key, _, sql in TRIGGERS if key == name)
        self.db._conn.execute('DROP TRIGGER ' + name)
        self.db._conn.execute('PRAGMA ignore_check_constraints=ON')
        self.db._conn.execute(f'UPDATE main.{META} SET schema_version=4')
        self.db._conn.execute('PRAGMA ignore_check_constraints=OFF')
        self.db._conn.execute(sql)
        self.assertCode('schema_mismatch', lambda: self.write(journal.migrate_on))


class TriggerTests(Fixture):
    def test_release_reservation_after_deny_refuses_at_sql_boundary(self):
        self.reserve(); self.begin(); self.issue(); self.ticket(); self.cancel()
        with self.assertRaises(sqlite3.IntegrityError):
            self.write(lambda conn: conn.execute(f'UPDATE main.{ATTEMPT} SET release_reserved=1'))
        self.assertEqual(self.inspect()['release_reserved'], 0)

    def test_pending_deny_cannot_advance_to_confirming(self):
        self.reserve()
        self.write(lambda conn: conn.execute(f'UPDATE main.{ATTEMPT} SET deny_requested=1'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.write(lambda conn: conn.execute(f"UPDATE main.{ATTEMPT} SET phase='confirming'"))
        self.assertEqual(self.inspect()['phase'], 'pending')
    def test_history_identity_and_profile_latch_never_reset(self):
        self.reserve()
        for sql, args in [(f'DELETE FROM {ATTEMPT}', ()), (f'DELETE FROM {META}', ()),
            (f'UPDATE {META} SET retained_count=0', ()),
            (f'UPDATE {ATTEMPT} SET context_digest=?', ('0' * 64,)),
            (f'INSERT OR REPLACE INTO {META} VALUES(1,3,?,0)', (DIGEST,))]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.write(lambda conn: conn.execute(sql, args))
        self.assertEqual(self.inspect()['phase'], 'pending')

    def test_deny_release_and_phase_monotonicity_at_sql_boundary(self):
        self.ready(); self.cancel()
        for change in ['deny_requested=0', "phase='bound',binding_id='" + 'f' * 32 + "'", 'release_reserved=0']:
            with self.assertRaises(sqlite3.IntegrityError):
                self.write(lambda conn: conn.execute(f'UPDATE main.{ATTEMPT} SET {change}'))
        self.assertEqual(self.inspect()['deny_requested'], 1)

