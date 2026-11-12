"""Lossy, bounded UI projection. No arguments, tool output or reasoning leave here."""
import hashlib
import re
import time

LIMIT = 12
INTERVAL = 0.1

MCP_PROVIDERS = {
    'chrome_devtools': 'chrome', 'chrome-devtools': 'chrome', 'chrome': 'chrome',
    'stellar_workspace': 'stellar', 'stellar-workspace': 'stellar', 'stellar': 'stellar',
    'github': 'github', 'google_calendar': 'calendar', 'google-calendar': 'calendar',
    'calendar': 'calendar', 'spotify': 'spotify',
}


def metadata(name, kind):
    provider = 'mcp' if kind == 'mcp' else 'web' if kind == 'web' else 'local'
    operation_name = name.lower()
    if kind == 'mcp':
        remainder = operation_name.removeprefix('mcp__').removeprefix('mcp_')
        for server, known in MCP_PROVIDERS.items():
            if remainder.startswith(server + '_'):
                provider = known
                operation_name = remainder[len(server):].lstrip('_')
                break
        else:
            return {'provider': provider, 'operation': 'call'}
    if kind == 'shell':
        return {'provider': provider, 'operation': 'execute'}
    if kind in {'memory', 'skill', 'skill_create'}:
        return {'provider': provider, 'operation': 'update'}
    for word in re.split('[^a-z0-9]+', operation_name):
        operation = {
            'search': 'search', 'find': 'search', 'read': 'read', 'get': 'read',
            'fetch': 'read', 'list': 'list', 'inspect': 'inspect', 'capture': 'inspect',
            'open': 'open', 'navigate': 'open', 'present': 'open', 'show': 'open',
            'write': 'write', 'create': 'write', 'edit': 'update', 'patch': 'update',
            'update': 'update', 'delete': 'update', 'remove': 'update',
        }.get(word)
        if operation:
            return {'provider': provider, 'operation': operation}
    return {'provider': provider, 'operation': 'call'}


def category(name, args):
    action = args.get('action')
    action = action if type(action) is str else ''
    if name == 'skill_manage' and action == 'create':
        return 'skill_create'
    if name == 'skill_manage' and action in {'edit', 'patch', 'write_file', 'remove_file', 'batch'}:
        return 'skill'
    if name == 'memory' and (action in {'add', 'patch', 'remove', 'batch'} or
                             type(args.get('operations')) is list and args['operations']):
        return 'memory'
    if name in {'terminal', 'shell', 'execute_code'}:
        return 'shell'
    if name in {'web_search', 'web_extract', 'browser_navigate', 'browser_search'}:
        return 'web'
    if name in {'read_file', 'search_files', 'list_directory'}:
        return 'file_read'
    if name in {'write_file', 'patch', 'edit_file', 'apply_patch'}:
        return 'file_write'
    if name.startswith(('mcp_', 'mcp__')):
        return 'mcp'
    return 'tool'


def outcome(payload, kind):
    result = payload.get('result')
    if type(result) is dict:
        if result.get('success') is False or result.get('isError') is True or result.get('error'):
            return 'failed'
        # Staged writes await approval; a successful staging is not a completed update.
        if result.get('success') is True and not result.get('staged') and not result.get('pending'):
            return 'completed'
        if kind not in {'memory', 'skill', 'skill_create'} and type(result.get('exit_code')) is int:
            return 'completed' if result['exit_code'] == 0 else 'failed'
    return 'finished'


class Activity:
    def __init__(self):
        self.key = None
        self.rows = {}
        self.frame = None
        self.dirty = False
        self.last_emit = 0

    def offer(self, params):
        payload = params.get('payload', {})
        sid, aid = params.get('session_id'), params.get('admission_id')
        generation, epoch = params.get('execution_generation'), params.get('replay_epoch')
        seq = params.get('seq')
        if (type(payload) is not dict or not all(type(v) is str and 0 < len(v) <= 512
                for v in (sid, aid, epoch, payload.get('tool_id'), payload.get('name')))
                or type(generation) is not int or generation < 0 or type(seq) is not int or seq < 0):
            return
        key = sid, aid, generation, epoch
        if key != self.key:
            self.rows.clear()
            self.key = key
        elif self.frame is not None and seq <= self.frame['seq']:
            return
        token = hashlib.sha256(payload['tool_id'].encode()).hexdigest()[:16]
        args = payload.get('args')
        args = args if type(args) is dict else {}
        kind = self.rows.get(token, {}).get('kind', category(payload['name'], args))
        previous = self.rows.get(token)
        details = ({k: previous[k] for k in ('provider', 'operation')}
                   if previous else metadata(payload['name'], kind))
        row = {'id': token, 'kind': kind, **details,
               'state': 'running' if params['type'] == 'tool.start' else outcome(payload, kind)}
        if token not in self.rows and len(self.rows) == LIMIT:
            victim = next((k for k, v in self.rows.items() if v['state'] != 'running'), next(iter(self.rows)))
            del self.rows[victim]
        self.rows[token] = row
        self.frame = {k: params[k] for k in ('session_id', 'admission_id', 'execution_generation', 'replay_epoch', 'seq')}
        self.dirty = True

    def flush(self):
        if not self.dirty:
            return None
        self.dirty = False
        self.last_emit = time.monotonic()
        return {**self.frame, 'type': 'stellar.activity', 'payload': {'actions': list(self.rows.values())}}

    def delay(self):
        return max(0.001, INTERVAL - (time.monotonic() - self.last_emit)) if self.dirty else None
