"""Transaction-local disable and quiescence facts; never erase canonical history/custody."""
from .guards import GuardMixin


def disable(conn):
    from .cancellations import reserve
    reserve(conn)
    conn.execute("UPDATE stellar_bg_installation_v1 SET phase='disabled' WHERE singleton=1")
    conn.execute('UPDATE stellar_bg_producers_v1 SET active=0')
    bindings = conn.execute('SELECT binding_id FROM stellar_bg_bindings_v1').fetchall()
    conn.execute('UPDATE stellar_bg_bindings_v1 SET revoked=1')
    conn.execute("UPDATE session_admissions SET status='terminal',outcome='cancelled' "
        "WHERE status='queued' AND EXISTS (SELECT 1 FROM stellar_bg_events_v1 e "
        'JOIN stellar_bg_bindings_v1 b USING(binding_id) WHERE e.request_id=session_admissions.request_id '
        "AND session_admissions.principal_id='automation:' || json_extract(b.origin_json,'$.route') "
        "AND session_admissions.target_session_id=json_extract(b.origin_json,'$.sessionId'))")
    return {row[0]: GuardMixin._revocation(conn, row[0]) for row in bindings}


def custody(conn):
    return {'unfinishedEffects': conn.execute('SELECT count(*) FROM stellar_bg_effects_v1 WHERE finished=0').fetchone()[0],
        'executions': conn.execute("SELECT count(*) FROM session_admissions WHERE status IN ('started','unknown')").fetchone()[0],
        'workers': conn.execute("SELECT count(*) FROM worker_executions WHERE status IN ('registered','running','unknown')").fetchone()[0],
        'events': conn.execute('SELECT count(*) FROM stellar_bg_events_v1').fetchone()[0]}
