"""Bounded workspace operations and pending reply ownership for the private bridge."""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import re
import secrets

MAX_PAYLOAD = 65536
MAX_FRAME = 400000
MAX_PANES = 4
ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$', re.ASCII)
SURFACES = frozenset({'rich-text', 'image', 'browser', 'diagram', 'workflow',
                      'session', 'assistant-message'})
METADATA_SURFACES = SURFACES | {'activity-summary'}
PROMINENCE = frozenset({'primary', 'secondary'})
PAYLOAD_LIMITS = {'rich-text': 65536, 'image': 65536, 'assistant-message': 65536,
                  'diagram': 16384, 'browser': 4096, 'workflow': 2048, 'session': 2048}


class WorkspaceRefused(Exception):
    pass


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def _identity(value):
    return type(value) is str and ID.fullmatch(value) is not None


def _payload(value, limit):
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
    fields = {
        'open': {'instance_id', 'surface', 'payload_json', 'prominence'},
        'update': {'instance_id', 'surface', 'payload_json'},
        'remove': {'instance_id'}, 'focus': {'instance_id'},
        'arrange': {'instance_ids'}, 'clear': set(), 'inspect': set(),
        'capture_window': set(),
    }
    if kind not in fields or set(operation) != fields[kind] | {'kind'}:
        raise WorkspaceRefused()
    if 'instance_id' in operation and not _identity(operation['instance_id']):
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
        _payload(operation['payload_json'], PAYLOAD_LIMITS[operation['surface']])
    return dict(operation)


def validate_outcome(outcome, operation):
    if type(outcome) is not dict:
        raise WorkspaceRefused()
    kind = outcome.get('kind')
    if type(kind) is not str:
        raise WorkspaceRefused()
    if kind in ('applied', 'rejected') and set(outcome) == {'kind'}:
        return outcome
    if kind != 'inspection' or operation != 'inspect' or set(outcome) != {'kind', 'panes'}:
        raise WorkspaceRefused()
    panes = outcome['panes']
    if type(panes) is not list or len(panes) > MAX_PANES:
        raise WorkspaceRefused()
    ids = set()
    for pane in panes:
        if (type(pane) is not dict or set(pane) != {'instance_id', 'surface', 'prominence', 'minimized'}
                or not _identity(pane['instance_id']) or pane['instance_id'] in ids
                or type(pane['surface']) is not str or pane['surface'] not in METADATA_SURFACES
                or type(pane['prominence']) is not str or pane['prominence'] not in PROMINENCE
                or type(pane['minimized']) is not bool):
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
        if (_contains_token(operation, turn_token) or
                ('payload_json' in operation and _contains_token(json.loads(operation['payload_json']), turn_token))):
            raise WorkspaceRefused()
        epoch, turn_id, _ = self.active
        request_id = secrets.token_hex(16)
        frame = {'event': 'workspace_tool', 'data': {
            'version': 1, 'request_id': request_id, 'epoch': epoch,
            'turn_id': turn_id, 'operation': operation,
        }}
        if len(json.dumps(frame, ensure_ascii=True, separators=(',', ':')).encode('utf-8')) + 1 > MAX_FRAME:
            raise WorkspaceRefused()
        future = asyncio.get_running_loop().create_future()
        pending = (request_id, epoch, turn_id, future, operation['kind'])
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
        if pending[4] == 'capture_window':
            raise WorkspaceRefused()
        outcome = validate_outcome(reply['outcome'], pending[4])
        pending[3].set_result(outcome)

    def reply_image(self, header, image):
        pending = self.pending
        if (pending is None or pending[4] != 'capture_window' or type(header) is not dict or
                set(header) != {'version', 'request_id', 'epoch', 'turn_id'} or
                type(header['version']) is not int or header['version'] != 1 or
                (header['request_id'], header['epoch'], header['turn_id']) != pending[:3] or
                self.active is None or self.active[:2] != pending[1:3] or pending[3].done() or
                type(image) is not bytes or not image.startswith(b'\x89PNG\r\n\x1a\n') or
                len(image) > 4 * 1024 * 1024):
            raise WorkspaceRefused()
        pending[3].set_result(image)

    def reject_image(self, header):
        pending = self.pending
        if (pending is None or pending[4] != 'capture_window' or type(header) is not dict or
                set(header) != {'version', 'request_id', 'epoch', 'turn_id'} or
                type(header['version']) is not int or header['version'] != 1 or
                (header['request_id'], header['epoch'], header['turn_id']) != pending[:3] or
                self.active is None or self.active[:2] != pending[1:3] or pending[3].done()):
            raise WorkspaceRefused()
        pending[3].set_exception(WorkspaceRefused())
