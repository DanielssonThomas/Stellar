"""Route an explicitly requested issue to the existing native retained view."""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from threading import Lock

from .core import Unavailable
from .overview import snapshot
from .overview_export import MAX_BYTES, _contract

MOD = 'stellar-retained-overview'
REQUEST_LIMIT = MAX_BYTES + 512
_request_lock = Lock()


def _overlays(core):
    overlays = core.app_call('status').get('overlays')
    if not isinstance(overlays, list) or overlays not in ([], [MOD]):
        raise Unavailable('Close the other Herdr overlay before opening the requested issue.')
    return overlays


def _publish(file, request):
    raw = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > REQUEST_LIMIT:
        raise Unavailable('The selected retained view exceeds its size limit.')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', dir=file.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(raw)
        os.replace(temporary, file)
    except OSError:
        raise Unavailable('The retained issue view could not be requested.') from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _request_path(settings):
    configured = settings.get('overview_snapshot')
    if isinstance(configured, str):
        source = Path(configured)
        if source.is_absolute() and source.name == f'{MOD}.json' and source.parent.is_dir():
            return source.with_name(f'{MOD}-request.json')
    raise Unavailable('The native retained overview is not configured.')


def _read_request(file):
    try:
        with file.open('rb') as stream:
            payload = stream.read(REQUEST_LIMIT + 1)
        return json.loads(payload) if len(payload) <= REQUEST_LIMIT else None
    except (OSError, ValueError):
        return None


def _loaded(request, reply):
    if not isinstance(reply, dict):
        return False
    overlay = reply.get('overlay')
    loaded = reply.get('loadedAt')
    return (type(overlay) is str and 0 < len(overlay) <= 128 and
            type(loaded) in (int, float) and request['createdAt'] <= loaded <= request['expiresAt'] and
            reply == {**request, 'loadedAt': loaded, 'overlay': overlay})


def present_issue(root, settings, core, issue):
    if type(issue) is not int or not 1 <= issue <= 2**31 - 1:
        raise Unavailable('Specify a Stellar issue number.')
    try:
        current = core.terminals()
    except Unavailable:
        current = []
    matches = sorted(
        (row for row in current if row['issue'] == issue and row['state'] in ('live', 'finished')),
        key=lambda row: row['state'] != 'live',
    )
    for worker in matches:
        try:
            view = core.focus(worker)
        except Unavailable:
            continue
        return {'view': 'open', 'issue': issue, 'worker_view': view}

    path = _request_path(settings)
    data = snapshot(root, core, issue=issue)
    if not data['workers'] or any(row['issue'] != issue for row in data['workers']):
        raise Unavailable('There are no confirmed retained attempts for the requested issue.')
    with _request_lock:
        core.show()
        visible = _overlays(core)
        now = time.time()
        request = {
            'schemaVersion': 1, 'id': uuid.uuid4().hex, 'issue': issue,
            'createdAt': now, 'expiresAt': now + 8, 'phase': 'opening',
            'snapshot': json.loads(_contract(data)),
        }
        if not visible:
            _publish(path, request)
            response = core.app_call('do', 'mod.open', '--name', MOD)
            if response.get('ok') is not True:
                raise Unavailable('Herdr did not open the retained overview.')
        if _overlays(core) != [MOD]:
            raise Unavailable('Herdr did not confirm the retained overlay was open.')
        now = time.time()
        request = {**request, 'phase': 'ready', 'createdAt': now, 'expiresAt': now + 8}
        _publish(path, request)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and time.time() < request['expiresAt']:
            reply = _read_request(path)
            if _loaded(request, reply) and time.time() < request['expiresAt']:
                return {'view': 'rendered', 'issue': issue, 'worker_view': 'retained-overview',
                        'request_id': request['id'], 'overlay_id': reply['overlay'],
                        'rendered_at': reply['loadedAt'],
                        'retained_attempts': len(request['snapshot']['workers'])}
            time.sleep(0.1)
        raise Unavailable('Herdr did not confirm loading the requested retained issue.')
