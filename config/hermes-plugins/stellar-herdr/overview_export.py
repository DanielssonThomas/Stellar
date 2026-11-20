"""One-shot bounded JSON export for the retained Herdr overview."""
from __future__ import annotations

import json
import importlib
import math
import os
import tempfile
import time
from pathlib import Path

MAX_BYTES = 64 * 1024
MAX_WORKERS = 20
MAX_WARNINGS = 32
WORKER_FIELDS = frozenset({
    'issue', 'role', 'claim_session', 'runtime_session', 'attempt', 'incarnation',
    'terminal', 'branch', 'target', 'baseline', 'process', 'status', 'exit_code',
    'tests', 'review', 'merge', 'observed_at', 'source', 'issue_source', 'summary',
})


def unavailable(warning='Retained overview projection unavailable.'):
    """Return a warning without erasing or replacing prior data."""
    return {'schemaVersion': 1, 'generated_at': time.time(),
            'coverage': 'unavailable', 'warnings': [warning], 'workers': [],
            'available': False}


def _contract(data):
    if type(data) is not dict or not isinstance(data.get('workers'), list):
        raise ValueError('Invalid retained overview projection.')
    workers = []
    for item in data['workers'][:MAX_WORKERS]:
        if type(item) is not dict:
            continue
        workers.append({key: item[key] for key in WORKER_FIELDS if key in item})
    warnings = data.get('warnings', [])
    if not isinstance(warnings, list):
        warnings = ['Projection warnings were malformed.']
    generated_at = data.get('generated_at')
    if (not isinstance(generated_at, (int, float)) or isinstance(generated_at, bool)
            or not math.isfinite(generated_at)
            or generated_at < 0):
        raise ValueError('Projection generation time must be Unix seconds.')
    coverage = data.get('coverage')
    if not isinstance(coverage, str) or not coverage:
        raise ValueError('Projection coverage is missing.')
    snapshot = {
        'schemaVersion': 1,
        'generated_at': generated_at,
        'coverage': coverage[:1024],
        'warnings': [str(value)[:512] for value in warnings[:MAX_WARNINGS]],
        'workers': workers,
        'available': True,
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > MAX_BYTES:
        raise ValueError('Retained overview snapshot exceeds the 64 KiB limit.')
    return encoded


def export_snapshot(root: Path, core, destination: Path):
    """Use the existing #366 retained projection; atomically publish only valid data."""
    destination = Path(destination)
    try:
        projection = importlib.import_module('.overview', __package__).snapshot
    except (ImportError, AttributeError):
        return unavailable('Retained overview projection is not integrated yet.')
    try:
        data = projection(Path(root), core)
        encoded = _contract(data)
    except (OSError, ValueError, TypeError, RuntimeError):
        return unavailable('Retained overview source is unavailable or malformed.')
    temporary = None
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='wb', dir=destination.parent,
                                         prefix=f'.{destination.name}.', suffix='.tmp',
                                         delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except OSError:
        return unavailable('Retained overview snapshot could not be written; last-good data is retained.')
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    return json.loads(encoded)
