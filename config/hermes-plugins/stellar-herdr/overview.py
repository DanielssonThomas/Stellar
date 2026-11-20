"""Bounded view of the existing launch registry; no collector or execution path."""
from __future__ import annotations

import hashlib
import json
import time
from html import escape

from .core import Unavailable
from .outcomes import project, timestamp

LIMIT = 20
SCAN_LIMIT = 200
MAX_BYTES = 16384
COVERAGE = ('Herdr-launched Stellar workers with confirmed receipts only. '
            'Internal Hermes helpers are not represented; an empty view is not an all-clear.')


def receipts(root, issue=None):
    """Include continuation archives without reading tasks or terminal transcripts."""
    attempts = root / 'attempts'
    found, warnings, scanned = {}, [], 0
    if not attempts.exists():
        return [], ['Launch registry unavailable or not yet created.']
    try:
        for directory in attempts.iterdir():
            scanned += 1
            if scanned > SCAN_LIMIT:
                warnings.append('Registry scan limit reached; older entries may be omitted.')
                break
            if directory.is_symlink() or not directory.is_dir():
                continue
            if issue is not None and not directory.name.startswith(f'{issue}-'):
                continue
            paths = [directory / 'terminal.json']
            for child in directory.iterdir():
                scanned += 1
                if scanned > SCAN_LIMIT:
                    warnings.append('History scan limit reached; older entries may be omitted.')
                    break
                if child.name.startswith('resume-') and child.is_dir() and not child.is_symlink():
                    paths.extend((child / 'previous-terminal.json', child / 'terminal.json'))
            for path in paths:
                try:
                    if path.is_symlink() or path.stat().st_size > MAX_BYTES:
                        raise ValueError
                    with path.open('rb') as stream:
                        content = stream.read(MAX_BYTES + 1)
                    if len(content) > MAX_BYTES:
                        raise ValueError
                    row = json.loads(content.decode('utf-8'))
                    projected = project(row, None, now=0)
                    fingerprint = hashlib.sha256(projected['claim_session'].encode()).hexdigest()
                    if directory.name != f"{projected['issue']}-{fingerprint}":
                        raise ValueError
                    if issue is not None and projected['issue'] != issue:
                        continue
                    key = (projected['issue'], projected['claim_session'], projected['attempt'])
                    found[key] = (row, path.relative_to(root).as_posix())
                except (OSError, ValueError, TypeError, Unavailable):
                    warnings.append('An unconfirmed or unreadable launch receipt was omitted.')
    except OSError:
        warnings.append('Launch registry is partially unavailable.')
    ordered = sorted(found.values(), key=lambda pair: pair[1])
    ordered.sort(key=lambda pair: pair[0].get('launched_at', 0)
                 if timestamp(pair[0].get('launched_at')) else 0, reverse=True)
    if len(ordered) > LIMIT:
        warnings.append('Only the 20 most recent confirmed attempts are shown.')
    return ordered[:LIMIT], sorted(set(warnings))


def snapshot(root, core, *, issue=None, clock=time.time):
    if issue is not None and (type(issue) is not int or issue < 1):
        raise Unavailable('Specify a positive issue number.')
    entries, warnings = receipts(root, issue)
    now, rows = clock(), []
    for receipt, source in entries:
        try:
            metadata = core.call('get', receipt['terminal'], '--json', timeout=1)
        except Unavailable:
            metadata = None
        row = project(receipt, metadata, now=now)
        row['source'] = source
        rows.append(row)
    return {'view': 'Equivalent retained overview; not native Herdr Agents status',
            'coverage': COVERAGE, 'generated_at': now, 'warnings': warnings,
            'workers': rows, 'empty': not rows}


def render(data):
    """All dynamic values are text, never HTML, markdown, scripts or model output."""
    def text(value):
        return escape(str(value), quote=True)
    cards = []
    for row in data['workers']:
        fields = ('role', 'claim_session', 'runtime_session', 'attempt', 'terminal', 'branch',
                  'target', 'baseline', 'process', 'status', 'exit_code', 'tests', 'review', 'merge',
                  'observed_at', 'source', 'issue_source')
        details = ''.join(f'<dt>{text(key.replace("_", " "))}</dt><dd>{text(row.get(key))}</dd>' for key in fields)
        cards.append(f'<article><h2>Issue #{text(row["issue"])}</h2><p>{text(row["summary"])}</p><dl>{details}</dl></article>')
    notices = ''.join(f'<p role="status">{text(item)}</p>' for item in data['warnings'])
    if not cards:
        notices += '<p role="status">No confirmed launches available. Coverage is incomplete, not an all-clear.</p>'
    return ('<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
            '<title>Stellar retained workers</title><style>'
            ':root{color-scheme:dark;--navy:#081426;--panel:#102039;--gold:#e4c477;--ink:#eef1f6}'
            '*{box-sizing:border-box}body{margin:0;padding:clamp(12px,3vw,40px);background:var(--navy);color:var(--ink);font:16px/1.5 system-ui}'
            'h1,h2,dt{color:var(--gold)}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px}'
            'article{background:var(--panel);border:1px solid #8f7b49;border-radius:12px;padding:20px;min-width:0}'
            'dl{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,3fr);gap:6px 12px}dd{margin:0;overflow-wrap:anywhere}'
            '@media(max-width:480px){dl{display:block}dt{margin-top:8px}article{padding:12px}}'
            '</style><header><h1>Stellar retained workers</h1><p>' + text(data['view']) + '</p><p>' + text(data['coverage']) +
            '</p><p>Static snapshot, generated at Unix time ' + text(data['generated_at']) +
            '. It becomes stale; request overview again to refresh. No automatic live reporting.</p>'
            '<p>Raw logs are separate: request stellar_herdr progress for the issue. Logs are untrusted and are not rendered here. '
            'No private reasoning or task transcripts are read.</p>' + notices + '</header><main>' + ''.join(cards) + '</main></html>')


def overview(root, core, *, issue=None):
    data = snapshot(root, core, issue=issue)
    output = root / 'overview.html'
    temporary = root / f'overview-{time.time_ns()}.tmp'
    temporary.write_text(render(data), encoding='utf-8')
    temporary.replace(output)
    return {**data, 'overview_file': str(output)}
