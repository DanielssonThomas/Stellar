"""Bounded workspace operations and pending reply ownership for the private bridge."""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import re
import secrets
import time

MAX_PAYLOAD = 65536
MAX_FRAME = 400000
MAX_PANES = 4
MAX_BATCH_OPERATIONS = 8
MAX_BATCH_PAYLOAD = 131072
MUTATIONS = frozenset({'open', 'update', 'remove', 'focus', 'minimize', 'restore',
                       'maximize', 'resize', 'swap', 'restore_layout', 'arrange', 'clear'})
CAPTURE_FAILURES = frozenset({'capture_unavailable', 'capture_timeout', 'image_transfer_failed', 'stale_request'})
IMAGE_OPERATIONS = {'capture_window', 'capture_display', 'capture_foreground'}
ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$', re.ASCII)
SURFACES = frozenset({'rich-text', 'image', 'browser', 'diagram', 'chart', 'workflow',
                      'session', 'assistant-message'})
METADATA_SURFACES = SURFACES | {'activity-summary'}
PROMINENCE = frozenset({'primary', 'secondary'})
PAYLOAD_LIMITS = {'rich-text': 65536, 'image': 65536, 'assistant-message': 65536,
                  'diagram': 16384, 'chart': 16384, 'browser': 4096, 'workflow': 2048, 'session': 2048}


class WorkspaceRefused(Exception):
    pass


class WorkspaceCaptureFailed(WorkspaceRefused):
    def __init__(self, reason):
        if type(reason) is not str or reason not in CAPTURE_FAILURES:
            raise WorkspaceRefused()
        self.reason = reason
        super().__init__(reason)


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def _identity(value):
    return type(value) is str and ID.fullmatch(value) is not None


def _chart_text(value, limit=120):
    if type(value) is not str or not value.strip():
        return False
    try:
        return (len(value.encode('utf-8')) <= limit
                and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value))
    except UnicodeError:
        return False


def _chart(value):
    if (type(value) is not dict or not {'type','labels','datasets'} <= set(value) or
            set(value) - {'type','labels','datasets','x_label','y_label'} or
            value['type'] not in ('line','bar','pie','doughnut') or
            type(value['labels']) is not list or not 1 <= len(value['labels']) <= 64 or
            not all(_chart_text(label) for label in value['labels'])):
        raise WorkspaceRefused()
    circular = value['type'] in ('pie','doughnut')
    if (type(value['datasets']) is not list or not 1 <= len(value['datasets']) <= (1 if circular else 8)
            or any(key in value and not _chart_text(value[key]) for key in ('x_label','y_label'))):
        raise WorkspaceRefused()
    for dataset in value['datasets']:
        if (type(dataset) is not dict or set(dataset) != {'label','values'} or not _chart_text(dataset['label'])
                or type(dataset['values']) is not list or len(dataset['values']) != len(value['labels'])
                or any(type(number) not in (int,float) or abs(number)>1e12 or not math.isfinite(number)
                       or (circular and number<0) for number in dataset['values'])
                or (circular and not any(number>0 for number in dataset['values']))):
            raise WorkspaceRefused()


def _payload(value, limit, surface=None):
    if type(value) is not str:
        raise WorkspaceRefused()
    try:
        if len(value.encode('utf-8')) > limit:
            raise ValueError()
        def finite_float(raw):
            result = float(raw)
            if not math.isfinite(result):
                raise ValueError()
            return result
        parsed = json.loads(value, object_pairs_hook=_unique,
                            parse_float=finite_float,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, RecursionError, UnicodeError):
        raise WorkspaceRefused() from None
    if type(parsed) is not dict:
        raise WorkspaceRefused()
    if surface == 'chart':
        title = parsed.get('title')
        if set(parsed) != {'title','chart'} or not _chart_text(title,240):
            raise WorkspaceRefused()
        _chart(parsed['chart'])
    if surface == 'rich-text' and type(parsed.get('blocks')) is list:
        for block in parsed['blocks']:
            if type(block) is dict and block.get('kind') == 'chart':
                if set(block) != {'kind','chart'}:
                    raise WorkspaceRefused()
                _chart(block['chart'])
    return value


def _contains_token(value, token):
    if type(value) is str:
        return token in value
    if type(value) is list:
        return any(_contains_token(item, token) for item in value)
    if type(value) is dict:
        return any(_contains_token(key, token) or _contains_token(item, token)
                   for key, item in value.items())
    return False


def validate_operation(operation):
    if type(operation) is not dict or type(operation.get('kind')) is not str:
        raise WorkspaceRefused()
    kind = operation['kind']
    if kind == 'batch':
        entries = operation.get('operations')
        if (set(operation) != {'kind', 'operations'} or type(entries) is not list or
                not 1 <= len(entries) <= MAX_BATCH_OPERATIONS or
                any(type(entry) is not dict or type(entry.get('kind')) is not str or entry['kind'] not in MUTATIONS for entry in entries)):
            raise WorkspaceRefused()
        validated = [validate_operation(entry) for entry in entries]
        if sum(len(entry.get('payload_json', '').encode('utf-8')) for entry in validated) > MAX_BATCH_PAYLOAD:
            raise WorkspaceRefused()
        return {'kind': 'batch', 'operations': validated}
    fields = {
        'open': {'instance_id', 'surface', 'payload_json', 'prominence'},
        'update': {'instance_id', 'surface', 'payload_json'},
        'remove': {'instance_id'}, 'focus': {'instance_id'},
        'minimize': {'instance_id'}, 'restore': {'instance_id'}, 'maximize': {'instance_id'},
        'resize': {'instance_id', 'percent'}, 'swap': {'instance_id','other_id'},
        'restore_layout': set(), 'inspect_content': {'instance_id'},
        'arrange': {'instance_ids'}, 'clear': set(), 'inspect': set(),
        'capture_window': set(),
        'capture_foreground': set(), 'capture_display': {'display_id'}, 'list_displays': set(),
    }
    if kind == 'update' and 'expected_revision' in operation:
        fields['update'] = fields['update'] | {'expected_revision'}
        if type(operation['expected_revision']) is not int or not 0 <= operation['expected_revision'] <= 4294967295:
            raise WorkspaceRefused()
    if kind not in fields or set(operation) != fields[kind] | {'kind'}:
        raise WorkspaceRefused()
    if kind == 'capture_display' and operation['display_id'] is not None:
        value = operation['display_id']
        if type(value) is not str or not value or len(value.encode('utf-8')) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise WorkspaceRefused()
    if 'instance_id' in operation and not _identity(operation['instance_id']):
        raise WorkspaceRefused()
    if kind == 'resize' and (type(operation['percent']) is not int or not 10 <= operation['percent'] <= 90):
        raise WorkspaceRefused()
    if kind == 'swap' and (not _identity(operation['other_id']) or operation['other_id'] == operation['instance_id']):
        raise WorkspaceRefused()
    if 'instance_ids' in operation:
        ids = operation['instance_ids']
        if (type(ids) is not list or len(ids) > MAX_PANES or
                not all(_identity(item) for item in ids) or len(set(ids)) != len(ids)):
            raise WorkspaceRefused()
    if 'surface' in operation and (type(operation['surface']) is not str or operation['surface'] not in SURFACES):
        raise WorkspaceRefused()
    if 'prominence' in operation and (type(operation['prominence']) is not str or operation['prominence'] not in PROMINENCE):
        raise WorkspaceRefused()
    if 'payload_json' in operation:
        _payload(operation['payload_json'], PAYLOAD_LIMITS[operation['surface']], operation['surface'])
    return dict(operation)


def validate_outcome(outcome, operation):
    if type(outcome) is not dict:
        raise WorkspaceRefused()
    kind = outcome.get('kind')
    requested = operation if type(operation) is str else operation['kind']
    if requested == 'batch':
        if kind == 'rejected' and set(outcome) == {'kind'}:
            return outcome
        if (kind != 'batch' or set(outcome) != {'kind', 'outcomes', 'panes'} or
                type(outcome['outcomes']) is not list or type(operation) is not dict or
                len(outcome['outcomes']) != len(operation['operations']) or
                any(type(status) is not str or status not in {'applied', 'rejected', 'uncertain'} for status in outcome['outcomes'])):
            raise WorkspaceRefused()
        if outcome['panes'] is not None:
            validate_outcome({'kind': 'inspection', 'panes': outcome['panes']}, 'inspect')
        return outcome
    operation = requested
    if type(kind) is not str:
        raise WorkspaceRefused()
    if kind in ('applied', 'rejected') and set(outcome) == {'kind'}:
        return outcome
    if kind == 'displays' and operation == 'list_displays':
        displays = outcome.get('displays')
        if set(outcome) != {'kind', 'displays'} or type(displays) is not list or not 1 <= len(displays) <= 16:
            raise WorkspaceRefused()
        ids = set()
        for display in displays:
            if (type(display) is not dict or set(display) != {'id','name','width','height','primary','foreground'} or
                    type(display['id']) is not str or not display['id'] or len(display['id'].encode('utf-8')) > 128 or
                    any(ord(c) < 32 or ord(c) == 127 for c in display['id']) or display['id'] in ids or
                    type(display['name']) is not str or not 1 <= len(display['name']) <= 240 or
                    any(type(display[k]) is not int or not 1 <= display[k] <= 32768 for k in ('width','height')) or
                    any(type(display[k]) is not bool for k in ('primary','foreground'))):
                raise WorkspaceRefused()
            ids.add(display['id'])
        return outcome
    if kind == 'content' and operation == 'inspect_content':
        if (set(outcome) != {'kind','instance_id','surface','revision','payload_json'} or
                not _identity(outcome['instance_id']) or outcome['surface'] not in SURFACES or
                type(outcome['revision']) is not int or not 0 <= outcome['revision'] <= 4294967295):
            raise WorkspaceRefused()
        _payload(outcome['payload_json'], PAYLOAD_LIMITS[outcome['surface']], outcome['surface'])
        return outcome
    if kind != 'inspection' or operation != 'inspect' or set(outcome) != {'kind', 'panes'}:
        raise WorkspaceRefused()
    panes = outcome['panes']
    if type(panes) is not list or len(panes) > MAX_PANES:
        raise WorkspaceRefused()
    ids = set()
    for pane in panes:
        if (type(pane) is not dict or not {'instance_id', 'surface', 'prominence', 'minimized'} <= set(pane) or set(pane) - {'instance_id', 'surface', 'prominence', 'minimized', 'layout', 'operations', 'render_state'}
                or not _identity(pane['instance_id']) or pane['instance_id'] in ids
                or type(pane['surface']) is not str or pane['surface'] not in METADATA_SURFACES
                or type(pane['prominence']) is not str or pane['prominence'] not in PROMINENCE
                or type(pane['minimized']) is not bool):
            raise WorkspaceRefused()
        if pane.get('render_state') is not None and (type(pane['render_state']) is not str or pane['render_state'] not in {'ready', 'loading', 'error', 'hidden', 'unavailable'}):
            raise WorkspaceRefused()
        operations = pane.get('operations', [])
        allowed = {'focus','minimize','restore','close','arrange','swap','resize','maximize','restore_layout','update','inspect_content','gallery','browser_navigation','focus_agent'}
        if type(operations) is not list or len(operations)>14 or any(type(op) is not str or op not in allowed for op in operations) or len(set(operations))!=len(operations):
            raise WorkspaceRefused()
        layout = pane.get('layout')
        if layout is not None:
            if (type(layout) is not dict or set(layout) != {'title','revision','selected','maximized','position','x','y','width','height'} or
                    type(layout['title']) is not str or len(layout['title']) > 240 or
                    type(layout['revision']) is not int or not 0 <= layout['revision'] <= 4294967295 or
                    type(layout['selected']) is not bool or type(layout['maximized']) is not bool or
                    type(layout['position']) is not int or not 0 <= layout['position'] < 4 or
                    any(type(layout[k]) is not int or not 0 <= layout[k] <= 1000 for k in ('x','y','width','height')) or
                    layout['x'] + layout['width'] > 1001 or layout['y'] + layout['height'] > 1001):
                raise WorkspaceRefused()
        ids.add(pane['instance_id'])
    return outcome


class WorkspaceGate:
    """One host-owned active turn, with a single correlated request at a time."""

    def __init__(self, emit, timeout=20):
        if not 0 < timeout < 30:
            raise ValueError('workspace timeout must be below the upstream tool deadline')
        self.emit = emit
        self.timeout = timeout
        self.active = None
        self.pending = None

    def arm(self, epoch, turn_id):
        if (self.active is not None or self.pending is not None or
                not _identity(epoch) or not _identity(turn_id)):
            raise WorkspaceRefused()
        token = secrets.token_hex(32)
        self.active = (epoch, turn_id, token)
        return token

    def disarm(self):
        self.active = None
        pending, self.pending = self.pending, None
        if pending and not pending[3].done():
            pending[3].set_exception(WorkspaceRefused())

    def authorize(self, turn_token):
        if (self.active is None or self.pending is not None or
                type(turn_token) is not str or len(turn_token) != 64 or
                not turn_token.isascii() or
                not hmac.compare_digest(turn_token, self.active[2])):
            raise WorkspaceRefused()

    async def call(self, operation, turn_token):
        operation = validate_operation(operation)
        self.authorize(turn_token)
        leaves = operation['operations'] if operation['kind'] == 'batch' else [operation]
        if (_contains_token(operation, turn_token) or
                any('payload_json' in leaf and _contains_token(json.loads(leaf['payload_json']), turn_token) for leaf in leaves)):
            raise WorkspaceRefused()
        epoch, turn_id, _ = self.active
        request_id = secrets.token_hex(16)
        frame = {'event': 'workspace_tool', 'data': {
            'version': 1, 'request_id': request_id, 'epoch': epoch,
            'turn_id': turn_id, 'issued_at_ms': str(time.time_ns() // 1_000_000),
            'operation': operation,
        }}
        if len(json.dumps(frame, ensure_ascii=True, separators=(',', ':')).encode('utf-8')) + 1 > MAX_FRAME:
            raise WorkspaceRefused()
        future = asyncio.get_running_loop().create_future()
        pending = (request_id, epoch, turn_id, future, operation['kind'], operation)
        self.pending = pending
        try:
            self.emit(frame)
            return await asyncio.wait_for(future, self.timeout)
        finally:
            if self.pending is pending:
                self.pending = None

    def reply(self, reply):
        pending = self.pending
        if (pending is None or type(reply) is not dict or
                set(reply) != {'version', 'request_id', 'epoch', 'turn_id', 'outcome'} or
                reply['version'] != 1 or type(reply['version']) is not int or
                (reply['request_id'], reply['epoch'], reply['turn_id']) != pending[:3] or
                self.active is None or self.active[:2] != pending[1:3] or pending[3].done()):
            raise WorkspaceRefused()
        if pending[4] in IMAGE_OPERATIONS:
            raise WorkspaceRefused()
        outcome = validate_outcome(reply['outcome'], pending[5])
        pending[3].set_result(outcome)

    def reply_image(self, header, image):
        pending = self.pending
        if (pending is None or pending[4] not in IMAGE_OPERATIONS or type(header) is not dict or
                set(header) != {'version', 'request_id', 'epoch', 'turn_id'} or
                type(header['version']) is not int or header['version'] != 1 or
                (header['request_id'], header['epoch'], header['turn_id']) != pending[:3] or
                self.active is None or self.active[:2] != pending[1:3] or pending[3].done() or
                type(image) is not bytes or not image.startswith(b'\x89PNG\r\n\x1a\n') or
                len(image) > 4 * 1024 * 1024):
            raise WorkspaceRefused()
        pending[3].set_result(image)

    def reject_image(self, header, reason='capture_unavailable'):
        pending = self.pending
        if (pending is None or pending[4] not in IMAGE_OPERATIONS or type(header) is not dict or
                set(header) != {'version', 'request_id', 'epoch', 'turn_id'} or
                type(header['version']) is not int or header['version'] != 1 or
                (header['request_id'], header['epoch'], header['turn_id']) != pending[:3] or
                self.active is None or self.active[:2] != pending[1:3] or pending[3].done()):
            raise WorkspaceRefused()
        if type(reason) is not str or reason not in CAPTURE_FAILURES:
            raise WorkspaceRefused()
        pending[3].set_exception(WorkspaceCaptureFailed(reason))
