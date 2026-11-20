"""Pure, transcript-free projection of confirmed Herdr launch receipts."""
from __future__ import annotations

import hashlib
import math
import re

from .observation_sources import validate_receipt

STATUS_MAX_AGE = 300
SESSION = re.compile(r'[a-zA-Z0-9._:-]{1,128}')


def timestamp(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def project(receipt, row, *, now):
    """Process observations are not evidence of tests, independent review or merge."""
    exact = validate_receipt(receipt)
    runtime = receipt.get('runtime_session_id')
    if not isinstance(runtime, str) or not SESSION.fullmatch(runtime):
        runtime = None
    result = {**exact, 'runtime_session': runtime, 'attempt': exact['incarnation'],
              'source': f"attempts/{exact['issue']}-{hashlib.sha256(exact['claim_session'].encode()).hexdigest()}/terminal.json",
              'issue_source': f"https://github.com/DanielssonThomas/Stellar/issues/{exact['issue']}",
              'process': 'unavailable', 'status': 'unavailable', 'exit_code': None,
              'tests': 'unverified', 'review': 'unverified', 'merge': 'unverified',
              'observed_at': now, 'summary': 'Retained launch; current process metadata unavailable.'}
    expected = {'stellar-delegate': 'ivy', 'issue': str(exact['issue']),
                'role': exact['role'], 'stellar-launch': exact['incarnation']}
    if (not isinstance(row, dict) or not isinstance(row.get('labels'), dict) or
            any(row['labels'].get(key) != value for key, value in expected.items()) or
            row.get('address') != exact['terminal']):
        return result
    state = row.get('state')
    if state not in ('live', 'finished'):
        return result
    result['process'] = 'running' if state == 'live' else 'exited'
    code = row.get('exit_code')
    if state == 'finished':
        result['exit_code'] = code if type(code) is int else None
        result['summary'] = ('Exited zero; work remains incomplete/unverified.' if type(code) is int and code == 0
                             else 'Process exited; work remains unverified.')
    else:
        result['summary'] = 'Process running; task progress status unavailable.'
    status, stamp = row.get('status'), row.get('status_ms')
    if status not in ('working', 'idle', 'done', 'blocked', 'waiting'):
        return result
    if (not isinstance(stamp, (int, float)) or not timestamp(stamp) or
            not timestamp(now) or not 0 <= now - stamp / 1000 <= STATUS_MAX_AGE):
        result['status'] = 'stale'
        result['summary'] += ' Reported task status is stale or undated.'
        return result
    result['status'] = status
    if status == 'blocked':
        blocked = 'Worker reports blocked; resolution and work remain unverified.'
        result['summary'] = blocked if state == 'live' else result['summary'] + ' ' + blocked
    elif state == 'live':
        result['summary'] = f'Process running; worker reports {status}. Work remains unverified.'
    return result
