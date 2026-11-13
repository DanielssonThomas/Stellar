"""Transactional consent and local transition journal, with no delivery authority."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager

from .core import Unavailable
from .observation_sources import KINDS, milestones

INTERVAL = 60
FRESHNESS = 300
RETENTION = 30 * 86400
TRACKING_TTL = 7 * 86400
LEASE = 120
MAX_TRACKED = 20
MAX_FAILURES = 6


class ObservationStore:
    def __init__(self, root):
        self.path = root / 'observations.sqlite3'

    @contextmanager
    def transaction(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=2)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            db.execute('''CREATE TABLE IF NOT EXISTS tracking (
                incarnation TEXT PRIMARY KEY, issue INTEGER NOT NULL, receipt TEXT NOT NULL,
                enabled INTEGER NOT NULL, revision INTEGER NOT NULL, kinds TEXT NOT NULL,
                expires REAL NOT NULL, next_poll REAL NOT NULL, lease TEXT, lease_until REAL,
                failures INTEGER NOT NULL, health TEXT NOT NULL, observed REAL, snapshot TEXT)''')
            db.execute('''CREATE TABLE IF NOT EXISTS transitions (
                identity TEXT PRIMARY KEY, incarnation TEXT NOT NULL, revision INTEGER NOT NULL,
                kind TEXT NOT NULL, fact TEXT NOT NULL, observed REAL NOT NULL)''')
            db.execute('CREATE TABLE IF NOT EXISTS consent (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO consent VALUES (1,0)')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def prune(db, now):
        db.execute('DELETE FROM transitions WHERE observed < ?', (now - RETENTION,))
        db.execute('DELETE FROM transitions WHERE incarnation IN '
                   '(SELECT incarnation FROM tracking WHERE expires <= ?)', (now,))
        db.execute("UPDATE tracking SET enabled=0, health='expired', lease=NULL WHERE expires <= ?", (now,))
        db.execute('DELETE FROM tracking WHERE expires < ?', (now - RETENTION,))

    def consent_revision(self):
        with self.transaction() as db:
            return db.execute('SELECT revision FROM consent WHERE id=1').fetchone()[0]

    def enable(self, receipt, kinds, facts, now, expected_revision):
        if (type(kinds) is not list or not kinds or any(type(kind) is not str for kind in kinds) or
                len(kinds) != len(set(kinds)) or
                any(kind not in KINDS for kind in kinds)):
            raise Unavailable('Choose a nonempty list of supported observation kinds.')
        key = receipt['incarnation']
        with self.transaction() as db:
            self.prune(db, now)
            if db.execute('SELECT revision FROM consent WHERE id=1').fetchone()[0] != expected_revision:
                raise Unavailable('Consent changed during source verification; tracking was not enabled.')
            previous = db.execute('SELECT * FROM tracking WHERE incarnation=?', (key,)).fetchone()
            if previous and json.loads(previous['receipt']) != receipt:
                raise Unavailable('This launch incarnation already has different provenance.')
            if not previous and db.execute('SELECT count(*) FROM tracking').fetchone()[0] >= MAX_TRACKED:
                raise Unavailable('Tracking retention is full; wait for retained tracking to expire.')
            # A new consent revision starts with a fresh baseline, never retrospective alerts.
            revision = expected_revision + 1
            db.execute('UPDATE consent SET revision=? WHERE id=1', (revision,))
            db.execute('DELETE FROM transitions WHERE incarnation IN '
                       '(SELECT incarnation FROM tracking WHERE issue=?)', (receipt['issue'],))
            db.execute("UPDATE tracking SET enabled=0, lease=NULL, health='superseded' WHERE issue=?", (receipt['issue'],))
            db.execute('INSERT OR REPLACE INTO tracking VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (key, receipt['issue'], json.dumps(receipt), 1, revision, json.dumps(kinds),
                        now + TRACKING_TTL, now + INTERVAL, None, 0, 0, 'current', now, json.dumps(facts)))
        return revision

    def disable(self, issue):
        with self.transaction() as db:
            db.execute('UPDATE consent SET revision=revision+1 WHERE id=1')
            db.execute('DELETE FROM transitions WHERE incarnation IN '
                       '(SELECT incarnation FROM tracking WHERE issue=?)', (issue,))
            db.execute("UPDATE tracking SET enabled=0, revision=revision+1, lease=NULL, health='opted_out' WHERE issue=?", (issue,))

    def reserve(self, now, *, tracks=None):
        with self.transaction() as db:
            self.prune(db, now)
            if tracks is not None and not tracks:
                return None
            scope = (' AND (' + ' OR '.join('(incarnation=? AND revision=?)' for _ in tracks) + ')'
                     if tracks is not None else '')
            row = db.execute('SELECT * FROM tracking WHERE enabled=1 AND next_poll<=? '
                             'AND (lease IS NULL OR lease_until<=?)' + scope + ' ORDER BY next_poll LIMIT 1',
                             (now, now, *(value for track in (tracks or ()) for value in track))).fetchone()
            if row is None:
                return None
            token = uuid.uuid4().hex
            db.execute('UPDATE tracking SET lease=?, lease_until=? WHERE incarnation=?',
                       (token, now + LEASE, row['incarnation']))
            return {**dict(row), 'lease': token}

    def finish(self, reserved, facts, now):
        with self.transaction() as db:
            row = db.execute('SELECT * FROM tracking WHERE incarnation=? AND revision=? '
                             'AND lease=? AND lease_until>? AND enabled=1 AND expires>?',
                             (reserved['incarnation'], reserved['revision'], reserved['lease'], now, now)).fetchone()
            if row is None:
                return
            if facts is None:
                failures = row['failures'] + 1
                db.execute('UPDATE tracking SET failures=?, health=?, next_poll=?, lease=NULL, enabled=? '
                           'WHERE incarnation=?', (failures, 'retry_exhausted' if failures >= MAX_FAILURES else 'unavailable',
                                                   now + min(3600, INTERVAL * 2**(failures - 1)),
                                                   int(failures < MAX_FAILURES), row['incarnation']))
                return
            previous = milestones(json.loads(row['snapshot']))
            kinds = json.loads(row['kinds'])
            for kind, fact in milestones(facts).items():
                if kind not in kinds or previous.get(kind) == fact:
                    continue
                encoded = json.dumps(fact, sort_keys=True)
                identity = hashlib.sha256(json.dumps([row['incarnation'], row['revision'], kind, encoded]).encode()).hexdigest()
                exists = db.execute('SELECT 1 FROM transitions WHERE identity=?', (identity,)).fetchone()
                count = db.execute('SELECT count(*) FROM transitions WHERE incarnation=?', (row['incarnation'],)).fetchone()[0]
                if not exists and count >= 100:
                    db.execute("UPDATE tracking SET enabled=0, health='journal_full', lease=NULL WHERE incarnation=?", (row['incarnation'],))
                    return
                db.execute('INSERT OR IGNORE INTO transitions VALUES (?,?,?,?,?,?)',
                           (identity, row['incarnation'], row['revision'], kind, encoded, now))
            db.execute("UPDATE tracking SET snapshot=?, observed=?, health='current', failures=0, next_poll=?, lease=NULL "
                       'WHERE incarnation=?', (json.dumps(facts), now, now + INTERVAL, row['incarnation']))

    def status(self, now):
        with self.transaction() as db:
            self.prune(db, now)
            tracking = [{key: row[key] for key in ('issue', 'incarnation', 'enabled', 'revision',
                                                   'expires', 'health', 'observed', 'failures')}
                        for row in db.execute('SELECT * FROM tracking ORDER BY issue, incarnation')]
            for item in tracking:
                if item['health'] == 'current' and not 0 <= now - item['observed'] <= FRESHNESS:
                    item['health'] = 'stale'
            # These are local observations. No method claims, dispatches or acknowledges a wake.
            transitions = [dict(row) for row in db.execute(
                'SELECT t.identity,t.kind,t.fact,t.observed,w.issue,w.incarnation,w.revision FROM transitions t '
                'JOIN tracking w ON w.incarnation=t.incarnation AND w.revision=t.revision '
                "WHERE w.enabled=1 AND w.health='current' AND t.observed>=? AND w.observed>=? "
                'AND t.observed<=? AND w.observed<=? ORDER BY t.observed DESC,t.identity LIMIT 100',
                (now - FRESHNESS, now - FRESHNESS, now, now))]
            for event in transitions:
                event['fact'] = json.loads(event['fact'])
            return {'tracking': tracking, 'transitions': transitions,
                    'delivery': 'blocked_supported_session_bound_producer_required'}
