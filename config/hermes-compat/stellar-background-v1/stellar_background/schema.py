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
    db._execute_write(write)
