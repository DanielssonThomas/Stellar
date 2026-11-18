"""Explicit retained-session load through native owner fences and this client's MCP transport."""
import re

from stellar_ivy_controls import Refused, settled_lease

MODELS = {'gpt-6.1-terra', 'gpt-6.1-sol'}
EDIT_POLICIES = {'ask', 'workspace_session', 'session'}
WORKSPACE = re.compile(r'mcp-editor_stellar_workspace_[0-9a-f]{8}\Z', re.ASCII)


def wire_id(value):
    if type(value) is not str or not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        return False
    try:
        return len(value.encode('utf-8')) <= 512
    except UnicodeError:
        return False


def reply(method, value):
    """Exact private load wire contract; never use the generic identity projection."""
    prepare = method == 'session.load.prepare'
    fields = {'session_id', 'stored_session_id', 'model'}
    if prepare:
        fields |= {'revision', 'generation', 'edit_policy', 'current_session_id'}
    code = 'protocol' if prepare else 'outcome_uncertain'
    if (type(value) is not dict or set(value) != fields
            or type(value.get('model')) is not str or value['model'] not in MODELS):
        raise Refused(code)
    for key in ('session_id', 'stored_session_id'):
        if not wire_id(value[key]):
            raise Refused(code)
    if prepare:
        current = value['current_session_id']
        if (type(value['edit_policy']) is not str or value['edit_policy'] not in EDIT_POLICIES
                or any(type(value[k]) is not int or not 0 <= value[k] <= 18446744073709551615
                       for k in ('revision', 'generation'))
                or (current is not None and not wire_id(current))):
            raise Refused(code)
    return {key: value[key] for key in fields}


def identity(value, sid, profile):
    info = value.get('info', {})
    if (value.get('session_id') != sid or not isinstance(value.get('stored_session_id'), str)
            or not value['stored_session_id'] or info.get('source') != 'acp'
            or info.get('profile_id') != str(profile) or info.get('model') not in MODELS
            or info.get('edit_approval_policy') not in EDIT_POLICIES):
        raise Refused('unavailable')
    return info


def idle(value):
    if value.get('running') is not False or value.get('pending') != [] or value.get('open_requests') != []:
        raise Refused('busy')


def own_selection(info, failure='unavailable'):
    tools = info.get('enabled_toolsets')
    if (type(tools) is not list or any(type(t) is not str for t in tools)
            or len([t for t in tools if t.startswith('mcp-editor_')]) != 1
            or not any(WORKSPACE.fullmatch(t) for t in tools)):
        raise Refused(failure)


async def current_idle(conn, current, target):
    if current is not None and current != target:
        before = await conn.client.rpc('session.resume', session_id=current)
        if before.get('session_id') != current:
            raise Refused('uncertain')
        idle(before)


async def prepare(conn, workspace, sid, profile):
    if workspace is None or workspace.task is None or conn.active:
        raise Refused('busy')
    description = await conn.client.rpc('runtime.describe')
    if 'acp-session-mcp-v1' not in description.get('capabilities', []):
        raise Refused('unavailable')
    try:
        conn.lease.acquire()
    except (ValueError, OSError):
        raise Refused('busy') from None
    try:
        await settled_lease(conn)
        await current_idle(conn, getattr(conn, 'selected_session', None), sid)
        value = await conn.client.rpc('session.resume', session_id=sid)
        info = identity(value, sid, profile)
        idle(value)
        # Rebind only the Desktop-owned singleton, never drop another editor's MCP selection.
        own_selection(info)
        for key in ('revision', 'execution_generation'):
            if type(value.get(key)) is not int or value[key] < 0:
                raise Refused('unavailable')
        return {'session_id':sid, 'stored_session_id':value['stored_session_id'],
                'revision':value['revision'], 'generation':value['execution_generation'],
                'current_session_id':getattr(conn, 'selected_session', None),
                'model':info['model'], 'edit_policy':info['edit_approval_policy']}
    finally:
        conn.lease.release()


async def commit(conn, workspace, params, profile):
    if workspace is None or workspace.task is None or conn.active:
        raise Refused('busy')
    try:
        conn.lease.acquire()
    except (ValueError, OSError):
        raise Refused('busy') from None
    try:
        await settled_lease(conn)
        sid = params['session_id']
        await current_idle(conn, params['current_session_id'], sid)
        before = await conn.client.rpc('session.resume', session_id=sid)
        info = identity(before, sid, profile)
        idle(before)
        own_selection(info)
        if (before['stored_session_id'] != params['stored_session_id'] or info['model'] != params['model']
                or info['edit_approval_policy'] != params['edit_policy']):
            raise Refused('uncertain')
        # These immutable fences/request ID are journaled by the native host before this effect.
        # Native retries inspect the same operation identity; no new operation is manufactured here.
        changed = await conn.client.rpc('session.mutate', session_id=sid,
            request_id=params['request_id'], expected_revision=params['revision'],
            expected_generation=params['generation'], operation='editor_mcp',
            payload={'mcp_servers':workspace.editor()['mcp_servers']})
        if changed.get('session_id') != sid or changed.get('operation') != 'editor_mcp':
            raise Refused('uncertain')
        value = await conn.client.rpc('session.resume', session_id=sid,
            editor={'mcp_servers':workspace.editor()['mcp_servers']})
        info = identity(value, sid, profile)
        idle(value)
        # A committed fingerprint does not prove discovery actually retained the server.
        own_selection(info, 'uncertain')
        if (value['stored_session_id'] != params['stored_session_id'] or info['model'] != params['model']
                or info['edit_approval_policy'] != params['edit_policy'] or not workspace.verifies(info)):
            raise Refused('uncertain')
        workspace.bind_session(sid)
        return {'session_id':sid, 'stored_session_id':value['stored_session_id'], 'model':info['model']}
    finally:
        conn.lease.release()
