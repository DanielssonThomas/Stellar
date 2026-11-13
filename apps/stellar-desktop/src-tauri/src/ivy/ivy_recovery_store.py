"""Bounded discovery in the fixed profile's canonical store; never an effect grant."""
from contextlib import closing
import json
import sqlite3

from stellar_ivy_notifications import marker, uint, text

LIMIT = 2048


def inventory(profile, snapshot):
    sid = snapshot['session_id']
    if snapshot['execution_generation'] > LIMIT:
        raise ValueError('recovery_generation_capacity')
    uri = (profile / 'state.db').resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True, timeout=0.25)) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        epoch = db.execute('SELECT epoch FROM runtime_epoch WHERE singleton=1').fetchone()
        session = db.execute('SELECT runtime_generation,runtime_revision FROM sessions WHERE id=?', (sid,)).fetchone()
        if (epoch is None or session is None or epoch[0] != snapshot['authority_epoch']
                or tuple(session) != (snapshot['execution_generation'], snapshot['revision'])):
            raise ValueError('recovery_snapshot_boundary')
        saved = db.execute('SELECT substr(value,1,65537) FROM state_meta WHERE key=?',
                           ('gateway.local_policy.v1:' + sid,)).fetchone()
        physical = json.loads(saved[0])['entry']['session_id'] if saved else sid
        text(physical, 512)
        paths = ('local_automation_v1', 'native_text_v1.automation')
        def field(name):
            return 'COALESCE(' + ','.join("json_extract(payload_json,'$." + p + '.' + name + "')" for p in paths) + ')'
        columns = ','.join(field(name) + ' AS ' + alias for name, alias in (
            ('plugin_notification','notice'), ('display_kind','kind'), ('notification_category','category'),
            ('owner','owner'), ('route','route'), ('target','target'), ('identity','identity')))
        rows = db.execute('SELECT admission_id,request_id,principal_id,seq,status,outcome,owner_epoch,generation,'
                          + columns + ' FROM session_admissions WHERE target_session_id=? ORDER BY seq LIMIT ?',
                          (sid, LIMIT + 1)).fetchall()
        if len(rows) > LIMIT:
            raise ValueError('recovery_capacity')
        generations = set()
        result = []
        for row in rows:
            generation = row['generation']
            if generation is not None:
                uint(generation)
                generations.add(generation)
            notice = row['notice']
            descriptor = None
            kind = 'ordinary' if row['kind'] in (None, 'process_complete', 'async_delegation_complete') else 'ignored'
            if row['category'] == 'diagnostic':
                kind = 'ignored'
            if notice is not None:
                if type(notice) is not str or len(notice.encode('utf-8')) > 65536:
                    raise ValueError('recovery_descriptor')
                value = json.loads(notice)
                if value.get('binding', {}).get('plugin_id') == 'stellar-herdr':
                    descriptor = marker(value, str(profile), sid, 'stellar-herdr')
                    bound = descriptor['binding']
                    identity = json.dumps(['plugin-notification', bound['binding_id'], bound['revision'],
                                           descriptor['event_id']], ensure_ascii=False, separators=(',', ':'))
                    if (row['kind'] != 'internal_notification' or row['category'] == 'diagnostic'
                            or row['principal_id'] != 'automation:' + bound['session_key']
                            or row['request_id'] != identity or row['identity'] != identity
                            or row['owner'] != sid or row['route'] != bound['session_key']
                            or row['target'] != physical or bound['session_id'] != physical):
                        raise ValueError('recovery_provenance')
                    kind = 'notification'
                else:
                    kind = 'ignored'
            for name in ('admission_id','request_id'):
                text(row[name], 1024)
            if (type(row['seq']) is not int or row['seq'] <= 0
                    or row['status'] not in ('queued','started','unknown','terminal')):
                raise ValueError('recovery_admission')
            result.append({'admission_id':row['admission_id'], 'input_id':row['request_id'],
                'sequence':row['seq'], 'generation':generation, 'authority':row['owner_epoch'],
                'kind':kind, 'descriptor':descriptor})
        # Every execution increments this persistent counter. Gaps include reset/compression
        # or incomplete imported/retired history and cannot be explained by a new cursor.
        if generations != set(range(1, snapshot['execution_generation'] + 1)):
            raise ValueError('recovery_unaccounted_generation')
        return physical, result
