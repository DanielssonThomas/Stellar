"""Bounded SQLite read model for the native-owned Ivy workspace."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import math
import os
from pathlib import Path
import re
import sqlite3
import time

VIEWS = ('overview', 'budget', 'sessions', 'patterns', 'skills')
APPLICATION_ID = 0x53544549
FILTERS = {
    'overview': (),
    'budget': ('issue_number', 'days'),
    'sessions': ('issue_number', 'session_id', 'agent', 'model', 'days'),
    'patterns': ('issue_number', 'session_id', 'fingerprint', 'technology', 'component',
                 'agent', 'model', 'days', 'skill', 'skill_version'),
    'skills': ('skill',),
}
LABEL = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.+:/@ -]{0,95}\Z', re.ASCII)
FINGERPRINT = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_:-]{0,95}\Z', re.ASCII)


def database_path():
    if os.name == 'nt':
        base = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
        return base / 'Stellar' / 'engineering-intelligence.sqlite'
    base = Path(os.environ.get('XDG_DATA_HOME', ''))
    if not base.is_absolute():
        base = Path.home() / '.local' / 'share'
    return base / 'stellar' / 'engineering-intelligence.sqlite'


def validate_query(view='overview', issue_number=None, session_id=None, fingerprint=None,
                   skill=None, technology=None, agent=None, model=None, days=None, limit=8,
                   component=None, skill_version=None):
    if view not in VIEWS or type(limit) is not int or not 1 <= limit <= 12:
        raise ValueError('Select a view and a row limit from 1 to 12.')
    filters = dict(issue_number=issue_number, session_id=session_id, fingerprint=fingerprint,
                   skill=skill, technology=technology, agent=agent, model=model, days=days,
                   component=component, skill_version=skill_version)
    filters = {key: value for key, value in filters.items() if value is not None}
    if any(key not in FILTERS[view] for key in filters):
        raise ValueError('Choose the view that supports your filters.')
    if 'skill_version' in filters and 'skill' not in filters:
        raise ValueError('Choose a skill when filtering by its version.')
    for key, value in filters.items():
        if key == 'issue_number':
            valid = type(value) is int and 1 <= value <= 2147483647
        elif key == 'days':
            valid = type(value) is int and 1 <= value <= 3650
        else:
            pattern = FINGERPRINT if key == 'fingerprint' else LABEL
            valid = type(value) is str and pattern.fullmatch(value) is not None
        if not valid:
            raise ValueError('Invalid engineering intelligence filter.')
    return view, filters, limit


def scope(filters, columns, date=None):
    conditions = []
    params = []
    for key, column in columns.items():
        if key in filters:
            conditions.append(f'{column} = ?')
            params.append(filters[key])
    if date is not None and 'days' in filters:
        start = datetime.now(timezone.utc) - timedelta(days=filters['days'])
        conditions.append(f'{date} >= ?')
        params.append(start.isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
    return (' WHERE ' + ' AND '.join(conditions) if conditions else ''), params


def clean(value):
    if isinstance(value, str):
        return ''.join(char for char in value[:160] if char.isprintable())
    return value if type(value) is int or (type(value) is float and math.isfinite(value)) else None


def rows(db, statement, params, limit):
    results = db.execute(statement + ' LIMIT ?', [*params, limit + 1]).fetchall()
    return {'rows': [{key: clean(row[key]) for key in row.keys()} for row in results[:limit]],
            'more': len(results) > limit}


def budget(db, filters, limit):
    where, params = scope(filters, {'issue_number': 'issue_number'})
    issues = rows(db, '''SELECT issue_number, baseline_tokens, estimated_tokens, allocated_tokens,
        profile, confidence, revision, recorded_at, observed_tokens, complete_sessions, session_count,
        baseline_variance AS baseline_variance_tokens, observed_variance AS observed_variance_tokens, over_budget
        FROM engineering_budget''' + where + ' ORDER BY issue_number DESC', params, limit)
    models = usage_by_model(db, filters, limit)
    ivy = usage_by_model(db, {**filters, 'agent': 'ivy'}, limit)
    allowance = rows(db, '''WITH ranked AS (
          SELECT source, window_minutes, resets_at, observed_at, used_percent,
                 ROW_NUMBER() OVER (PARTITION BY source, window_minutes ORDER BY observed_at DESC) AS position
          FROM allowance_observations
        ) SELECT source, window_minutes, resets_at, observed_at, used_percent FROM ranked
        WHERE position = 1 ORDER BY observed_at DESC, source, window_minutes''', [], limit)
    report = {'issues': issues, 'usage_by_model': models, 'ivy_reported_usage': ivy,
              'subscription_allowance': allowance, 'estimated_allowance_impact': None,
              'api_equivalent_cost': None}
    if 'days' in filters:
        report['usage_window'] = f"Whole-session token totals for sessions observed in the past {filters['days']} days."
    if 'issue_number' in filters:
        report['revisions'] = rows(db, '''SELECT revision, recorded_at, estimated_tokens, allocated_tokens,
            profile, confidence FROM budget_revisions WHERE issue_number = ? ORDER BY revision DESC''', params, limit)
    return report


def usage_by_model(db, filters, limit):
    where, params = scope(filters, {'issue_number': 's.issue_number', 'agent': 's.agent'}, 's.last_seen_at')
    return rows(db, '''WITH measured AS (
          SELECT s.id, s.agent, CASE WHEN u.session_id IS NULL THEN s.model ELSE u.model END AS model,
                 CASE WHEN u.session_id IS NULL THEN s.provider ELSE u.provider END AS provider, u.observed_tokens,
                 u.cached_tokens, u.uncached_tokens, COALESCE(u.complete, 0) AS complete
          FROM sessions AS s LEFT JOIN engineering_usage AS u ON u.session_id = s.id''' + where + '''
        ), per_session AS (
          SELECT id, agent, model, provider, SUM(observed_tokens) AS observed_tokens,
            CASE WHEN COUNT(cached_tokens) = COUNT(*) THEN SUM(cached_tokens) END AS cached_tokens,
            CASE WHEN COUNT(uncached_tokens) = COUNT(*) THEN SUM(uncached_tokens) END AS uncached_tokens,
            MIN(complete) AS complete
          FROM measured GROUP BY id, agent, model, provider
        ) SELECT agent, model, provider, SUM(observed_tokens) AS observed_tokens,
            CASE WHEN COUNT(cached_tokens) = COUNT(*) THEN SUM(cached_tokens) END AS cached_tokens,
            CASE WHEN COUNT(uncached_tokens) = COUNT(*) THEN SUM(uncached_tokens) END AS uncached_tokens,
            SUM(complete) AS complete_sessions, COUNT(*) AS session_count
        FROM per_session GROUP BY agent, model, provider ORDER BY observed_tokens DESC, agent, model, provider''',
        params, limit)


SESSION_FIELDS = {'issue_number': 'issue_number', 'session_id': 'id', 'agent': 'agent', 'model': 'model'}
FAILURE_FIELDS = {**SESSION_FIELDS, 'session_id': 'session_id', 'fingerprint': 'fingerprint',
                  'technology': 'technology', 'component': 'component'}


def sessions(db, filters, limit):
    where, params = scope(filters, SESSION_FIELDS, 'started_at')
    report = {'history': rows(db, '''SELECT id, issue_number, agent, model, provider, reasoning,
        started_at, ended_at, status, observed_tokens, cached_tokens, uncached_tokens, input_tokens,
        output_tokens, usage_complete, attempts, failures, diagnostic_failures
        FROM engineering_sessions''' + where + ' ORDER BY started_at DESC, id', params, limit)}
    if 'session_id' in filters and report['history']['rows']:
        report['failure_events'] = failure_events(db, {'session_id': filters['session_id']}, limit)
        report['attempts'] = rows(db, '''SELECT at, category, technology, component, exit_code, diagnostic,
            fingerprint, provenance FROM attempts WHERE session_id = ? ORDER BY at DESC, id''',
            [filters['session_id']], limit)
    return report


def failure_scope(filters):
    where, params = scope(filters, FAILURE_FIELDS, 'at')
    if 'skill' in filters:
        where += ' AND ' if where else ' WHERE '
        where += ('EXISTS (SELECT 1 FROM skill_activations AS a '
                  'WHERE a.session_id = engineering_failures.session_id AND a.skill = ? '
                  'AND a.at <= engineering_failures.at')
        params.append(filters['skill'])
        if 'skill_version' in filters:
            where += ' AND a.version = ?'
            params.append(filters['skill_version'])
        where += ')'
    return where, params


def failure_events(db, filters, limit):
    where, params = failure_scope(filters)
    return rows(db, '''SELECT fingerprint, technology, component, code, description, session_id,
        issue_number, agent, model, at, diagnostic, retry, resolved, provenance FROM engineering_failures'''
        + where + ' ORDER BY at DESC, fingerprint, session_id', params, limit)


def patterns(db, filters, limit):
    where, params = failure_scope(filters)
    targeted = 'fingerprint' in filters or 'session_id' in filters
    recurrence = '' if targeted else ' HAVING SUM(diagnostic = 0) >= 2'
    recurring = rows(db, '''WITH matching AS (
            SELECT fingerprint, technology, component, code, description, session_id, issue_number,
                   diagnostic, retry, resolved, at FROM engineering_failures''' + where + '''
        ), usage AS (
            SELECT fingerprint, technology, component, SUM(observed_tokens) AS associated_observed_tokens,
                   COUNT(observed_tokens) AS sessions_with_observed_tokens
            FROM (SELECT DISTINCT fingerprint, technology, component, session_id FROM matching
                  WHERE diagnostic = 0) AS affected
            LEFT JOIN engineering_sessions AS s ON s.id = affected.session_id
            GROUP BY fingerprint, technology, component
        )
        SELECT m.fingerprint, m.technology, m.component, MAX(m.code) AS code,
            MAX(m.description) AS description, SUM(m.diagnostic = 0) AS failure_count,
            SUM(m.diagnostic = 1) AS diagnostic_count,
            COUNT(DISTINCT CASE WHEN m.diagnostic = 0 THEN m.session_id END) AS affected_sessions,
            COUNT(DISTINCT CASE WHEN m.diagnostic = 0 THEN m.issue_number END) AS affected_issues,
            SUM(CASE WHEN m.diagnostic = 0 THEN m.retry END) AS retries,
            SUM(CASE WHEN m.diagnostic = 0 THEN m.resolved END) AS resolved,
            u.associated_observed_tokens, u.sessions_with_observed_tokens, MAX(m.at) AS latest_at
        FROM matching AS m LEFT JOIN usage AS u ON u.fingerprint = m.fingerprint
            AND u.technology IS m.technology AND u.component IS m.component
        GROUP BY m.fingerprint, m.technology, m.component''' + recurrence
        + ' ORDER BY failure_count DESC, affected_issues DESC, latest_at DESC, m.fingerprint, m.component',
        params, limit)
    report = {'recurring': recurring}
    if targeted:
        report['failure_events'] = failure_events(db, filters, limit)
    if not filters or set(filters) == {'fingerprint'}:
        where, params = scope(filters, {'fingerprint': 'fingerprint'})
        report['candidates'] = rows(db, '''SELECT fingerprint, technology, code, occurrences,
            issues, sessions, retries, investigation_start FROM engineering_candidates'''
            + where + ' ORDER BY occurrences DESC, issues DESC, fingerprint, investigation_start', params, limit)
        report['interventions'] = rows(db, '''SELECT id, fingerprint, kind, version, started_at,
            implementation_ref, expected_improvement, before_attempts, after_attempts, before_failures,
            after_failures, before_sessions, after_sessions, before_retries, after_retries,
            before_observed_tokens, after_observed_tokens, window_days, model, reasoning, complexity,
            evidence_status FROM engineering_interventions'''
            + where + ' ORDER BY started_at DESC, id', params, limit)
    return report


def skills(db, filters, limit):
    where, params = scope(filters, {'skill': 'skill'})
    ranking = 'recorded_at DESC' if filters else 'loaded_tokens DESC, static_tokens DESC, recorded_at DESC'
    versions = rows(db, '''SELECT skill, version, state, recorded_at, static_tokens, tokenizer,
        activations, loaded_tokens, reference_tokens, discovery_tokens, failures, retries,
        transfer_evidence FROM engineering_skills''' + where + f' ORDER BY {ranking}, skill, version',
        params, limit)
    matching = '' if not filters else ' WHERE a.skill = ? OR b.skill = ?'
    identical = rows(db, '''WITH latest AS (
            SELECT skill, version, state, content_hash, ROW_NUMBER() OVER (
                PARTITION BY skill ORDER BY recorded_at DESC, version DESC
            ) AS position FROM engineering_skills
        ), current AS (
            SELECT skill, version, content_hash FROM latest
            WHERE position = 1 AND state IN ('experimental', 'validated', 'maintained')
        ) SELECT a.skill, a.version, b.skill AS matching_skill, b.version AS matching_version
        FROM current AS a JOIN current AS b ON b.content_hash = a.content_hash AND b.skill > a.skill'''
        + matching + ' ORDER BY a.skill, b.skill', params * 2, limit)
    return {'versions': versions, 'identical_content': identical}


QUERIES = {'budget': budget, 'sessions': sessions, 'patterns': patterns, 'skills': skills}


def read_summary(query, path=None):
    view, filters, limit = query
    report = {'schema_version': 1, 'view': view, 'filters': filters, 'state': 'unavailable', 'data': {}}
    try:
        uri = (path or database_path()).absolute().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(uri, uri=True, timeout=0.1)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only = ON')
            db.execute('PRAGMA trusted_schema = OFF')
            deadline = time.monotonic() + 0.35
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            db.execute('BEGIN')
            if (db.execute('PRAGMA application_id').fetchone()[0] != APPLICATION_ID or
                    db.execute('PRAGMA user_version').fetchone()[0] != 1):
                return report
            keys = QUERIES if view == 'overview' else (view,)
            data = {key: QUERIES[key](db, filters, limit) for key in keys}
            return {**report, 'state': 'available', 'data': data}
    except (OSError, ValueError, sqlite3.Error):
        return report
