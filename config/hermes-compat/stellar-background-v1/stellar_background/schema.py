"""Explicit migration on the SAME SessionDB; this is not a second execution queue."""


def install_schema(db):
    def write(conn):
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_bindings_v1 (
            binding_id TEXT PRIMARY KEY, origin_json TEXT NOT NULL, revision INTEGER NOT NULL,
            expires INTEGER NOT NULL, maximum INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
            revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_events_v1 (
            binding_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
            request_id TEXT NOT NULL UNIQUE, descriptor_json TEXT NOT NULL,
            PRIMARY KEY(binding_id,event_id))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_effects_v1 (
            binding_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL,
            client TEXT NOT NULL, operation TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(binding_id,event_id,kind))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_owners_v1 (
            binding_id TEXT PRIMARY KEY, subject TEXT NOT NULL)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_producers_v1 (
            producer_id TEXT PRIMARY KEY, version TEXT NOT NULL, incarnation TEXT NOT NULL,
            epoch INTEGER NOT NULL, active INTEGER NOT NULL)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_versions_v1 (
            producer_id TEXT NOT NULL, incarnation TEXT NOT NULL, version TEXT NOT NULL,
            PRIMARY KEY(producer_id,incarnation))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_installation_v1 (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), phase TEXT NOT NULL, package_digest TEXT NOT NULL)''')
        conn.execute("INSERT OR IGNORE INTO stellar_bg_installation_v1 VALUES(1,'unmanaged_candidate','')")
        conn.execute('''CREATE TABLE IF NOT EXISTS stellar_bg_cancellations_v1 (
            admission_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, session_id TEXT NOT NULL,
            notified INTEGER NOT NULL DEFAULT 0)''')
    db._execute_write(write)
