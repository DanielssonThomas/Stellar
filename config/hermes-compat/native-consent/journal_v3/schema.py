"""Explicit same-DB migration only; no connect/commit/repair/PRAGMA mutation."""
import hashlib
import json
import sqlite3

from .errors import require

META = 'stellar_nc_meta_v3'
ATTEMPT = 'stellar_nc_attempt_v3'
SAFE = 9007199254740991


def hex_check(name, size=64):
    return (f"length(CAST({name} AS BLOB))={size} AND length({name})={size} "
            f"AND instr({name},char(0))=0 AND {name} NOT GLOB '*[^0-9a-f]*'")


def nullable_hex(name, size=64):
    return f'({name} IS NULL OR ({hex_check(name, size)}))'


TABLES = [
    (META, f'''CREATE TABLE main.{META} (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=3),
 schema_digest TEXT NOT NULL CHECK({hex_check('schema_digest')}),
 retained_count INTEGER NOT NULL CHECK(retained_count BETWEEN 0 AND 64)
) STRICT'''),
    (ATTEMPT, f'''CREATE TABLE main.{ATTEMPT} (
 challenge_id TEXT PRIMARY KEY NOT NULL CHECK({hex_check('challenge_id')}),
 profile_id TEXT NOT NULL UNIQUE CHECK(profile_id='ivy'),
 attachment_id TEXT NOT NULL UNIQUE CHECK({hex_check('attachment_id')}),
 context_json TEXT NOT NULL CHECK(length(CAST(context_json AS BLOB)) BETWEEN 1 AND 8192),
 context_digest TEXT NOT NULL CHECK({hex_check('context_digest')}),
 prepared_json TEXT NOT NULL CHECK(length(CAST(prepared_json AS BLOB)) BETWEEN 1 AND 16384),
 prepared_digest TEXT NOT NULL CHECK({hex_check('prepared_digest')}),
 created_ms INTEGER NOT NULL CHECK(created_ms BETWEEN 0 AND {SAFE}),
 phase TEXT NOT NULL CHECK(phase IN ('pending','confirming','issuing','issued','bound','cancelled')),
 deny_requested INTEGER NOT NULL CHECK(deny_requested IN (0,1)),
 intent_id TEXT UNIQUE CHECK({nullable_hex('intent_id')}),
 ticket_hash TEXT UNIQUE CHECK({nullable_hex('ticket_hash')}),
 ticket_deadline_ms INTEGER CHECK(ticket_deadline_ms IS NULL OR ticket_deadline_ms BETWEEN 1 AND {SAFE}),
 release_reserved INTEGER NOT NULL CHECK(release_reserved IN (0,1)),
 binding_id TEXT UNIQUE CHECK({nullable_hex('binding_id', 32)}),
 CHECK(
 (phase IN ('pending','confirming','cancelled') AND intent_id IS NULL AND ticket_hash IS NULL AND ticket_deadline_ms IS NULL AND release_reserved=0 AND binding_id IS NULL)
 OR (phase='issuing' AND intent_id IS NOT NULL AND ticket_hash IS NULL AND ticket_deadline_ms IS NULL AND release_reserved=0 AND binding_id IS NULL)
 OR (phase='issued' AND intent_id IS NOT NULL AND ticket_hash IS NOT NULL AND ticket_deadline_ms IS NOT NULL AND binding_id IS NULL)
 OR (phase='bound' AND intent_id IS NOT NULL AND ticket_hash IS NOT NULL AND ticket_deadline_ms IS NOT NULL AND release_reserved=1 AND binding_id IS NOT NULL)),
 CHECK(phase!='cancelled' OR deny_requested=1)
) STRICT'''),
]


def trigger(name, event, table, body, when=None):
    condition = f' WHEN {when}' if when else ''
    return (name, table, f'CREATE TRIGGER main.{name} {event} ON {table}{condition} BEGIN {body} END')


ABORT = "SELECT RAISE(ABORT,'consent history retained');"
IDENTITY = ('challenge_id', 'profile_id', 'attachment_id', 'context_json', 'context_digest',
            'prepared_json', 'prepared_digest', 'created_ms')
FROZEN = ('intent_id', 'ticket_hash', 'ticket_deadline_ms', 'binding_id')
monotonic = [
    'OLD.deny_requested=1 AND NEW.deny_requested=0',
    'OLD.release_reserved=1 AND NEW.release_reserved=0',
    "NOT (NEW.phase=OLD.phase OR (OLD.phase='pending' AND NEW.phase IN ('confirming','cancelled')) "
    "OR (OLD.phase='confirming' AND NEW.phase IN ('issuing','cancelled')) "
    "OR (OLD.phase='issuing' AND NEW.phase='issued') OR (OLD.phase='issued' AND NEW.phase='bound'))",
    "NEW.phase!=OLD.phase AND NEW.phase!='cancelled' AND (OLD.deny_requested!=0 OR NEW.deny_requested!=0)",
    "OLD.release_reserved=0 AND NEW.release_reserved=1 AND NOT (OLD.phase='issued' AND NEW.phase='issued' AND OLD.deny_requested=0 AND NEW.deny_requested=0)",
]
monotonic += [f'OLD.{key} IS NOT NULL AND NEW.{key} IS NOT OLD.{key}' for key in FROZEN]
for key, before, after in [('intent_id', 'confirming', 'issuing'), ('ticket_hash', 'issuing', 'issued'),
                           ('ticket_deadline_ms', 'issuing', 'issued'), ('binding_id', 'issued', 'bound')]:
    monotonic.append(f"OLD.{key} IS NULL AND NEW.{key} IS NOT NULL AND NOT (OLD.phase='{before}' AND NEW.phase='{after}')")

TRIGGERS = [
    trigger('stellar_nc_meta_nodelete_v3', 'BEFORE DELETE', META, ABORT),
    trigger('stellar_nc_attempt_nodelete_v3', 'BEFORE DELETE', ATTEMPT, ABORT),
    trigger('stellar_nc_attempt_identity_v3', 'BEFORE UPDATE', ATTEMPT, ABORT,
            ' OR '.join(f'NEW.{key} IS NOT OLD.{key}' for key in IDENTITY)),
    trigger('stellar_nc_attempt_monotonic_v3', 'BEFORE UPDATE', ATTEMPT, ABORT,
            ' OR '.join(f'({part})' for part in monotonic)),
    trigger('stellar_nc_attempt_count_v3', 'AFTER INSERT', ATTEMPT,
            f'UPDATE {META} SET retained_count=retained_count+1 WHERE singleton=1;'),
    trigger('stellar_nc_attempt_insert_v3', 'BEFORE INSERT', ATTEMPT, ABORT,
            f"(SELECT count(*) FROM main.{META})!=1 OR NEW.phase!='pending' OR NEW.deny_requested!=0 OR NEW.release_reserved!=0"),
    trigger('stellar_nc_meta_immutable_v3', 'BEFORE UPDATE', META, ABORT,
            'NEW.singleton IS NOT OLD.singleton OR NEW.schema_version IS NOT OLD.schema_version '
            'OR NEW.schema_digest IS NOT OLD.schema_digest OR NEW.retained_count!=OLD.retained_count+1 '
            f'OR NEW.retained_count!=(SELECT count(*) FROM main.{ATTEMPT})'),
]


def catalog_sql(sql):
    value = sql.strip(' \t\r\n')
    if value.endswith(';'):
        value = value[:-1]
    for prefix in ('CREATE TABLE ', 'CREATE TRIGGER '):
        if value.startswith(prefix + 'main.'):
            return prefix + value[len(prefix + 'main.'):]
    return value


EXPECTED = {name: ('table', name, catalog_sql(sql)) for name, sql in TABLES}
EXPECTED.update({name: ('trigger', table, catalog_sql(sql)) for name, table, sql in TRIGGERS})
EXPECTED.update({f'sqlite_autoindex_{ATTEMPT}_{n}': ('index', ATTEMPT, None) for n in range(1, 7)})
DIGEST = hashlib.sha256(json.dumps(EXPECTED, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
PREREQUISITES = {
    'stellar_bg_bindings_v1': 'binding_id origin_json revision expires maximum spent revoked created',
    'stellar_bg_owners_v1': 'binding_id subject',
    'stellar_bg_events_v1': 'binding_id event_id digest request_id descriptor_json',
    'stellar_bg_effects_v1': 'binding_id event_id kind client operation finished',
    'stellar_bg_cancellations_v1': 'admission_id binding_id session_id notified',
    'sessions': 'id ended_at',
    'session_admissions': 'admission_id request_id principal_id target_session_id status outcome',
}


def connection_guard(conn):
    require(conn.in_transaction, 'transaction_required')
    require(sqlite3.sqlite_version_info >= (3, 37), 'sqlite_unsupported')
    require(all(row[1] in ('main', 'temp') for row in conn.execute('PRAGMA database_list')), 'schema_environment')
    require(conn.execute('SELECT count(*) FROM temp.sqlite_schema').fetchone()[0] == 0, 'schema_environment')
    for setting, values in [('ignore_check_constraints', (0,)), ('recursive_triggers', (1,)),
                            ('writable_schema', (0,)), ('main.synchronous', (2, 3)), ('main.journal_mode', ('wal',))]:
        require(conn.execute('PRAGMA ' + setting).fetchone()[0] in values, 'schema_environment')
    for table, fields in PREREQUISITES.items():
        require([r[0] for r in conn.execute('SELECT type FROM main.sqlite_schema WHERE name=? LIMIT 2', (table,))]
                == ['table'], 'canonical_schema')
        require({r[1] for r in conn.execute(f'PRAGMA main.table_info({table})')} >= set(fields.split()), 'canonical_schema')


def catalog(conn):
    found = {}
    for kind, name, table, sql in conn.execute('SELECT type,name,tbl_name,sql FROM main.sqlite_schema'):
        if table.lower() in (META, ATTEMPT) or name.lower().startswith('stellar_nc_'):
            found[name] = kind, table, sql
        elif sql:
            # Conservative reference refusal includes quoted/case variants and even
            # benign mentions in comments/literals; never normalize fingerprint SQL.
            require(not any(owned in sql.lower() for owned in (META, ATTEMPT)), 'schema_mismatch')
    return found


def verify_schema_on(conn):
    connection_guard(conn)
    require(catalog(conn) == EXPECTED, 'schema_mismatch')
    rows = conn.execute(f'SELECT * FROM main.{META} LIMIT 2').fetchall()
    require(len(rows) == 1 and tuple(rows[0])[:3] == (1, 3, DIGEST), 'schema_mismatch')
    count = conn.execute(f'SELECT count(*) FROM main.{ATTEMPT}').fetchone()[0]
    require(rows[0][3] == count and 0 <= count <= 64, 'history_mismatch')


def migrate_on(conn):
    connection_guard(conn)
    found = catalog(conn)
    if found:
        from .integrity import verify_on
        verify_on(conn)
        return
    for _, sql in TABLES:
        conn.execute(sql)
    for _, _, sql in TRIGGERS:
        conn.execute(sql)
    conn.execute(f'INSERT INTO main.{META} VALUES(1,3,?,0)', (DIGEST,))
    from .integrity import verify_on
    verify_on(conn)
