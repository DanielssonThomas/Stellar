"""Fixed attach-only JSONL bridge. Host imports and awaits serve(); no CLI."""
from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
PROFILE = Path('D:/Hermes/profiles/ivy')
INSTALL = 'D:/Hermes/hermes-agent'
INTEGRATION = PROFILE / 'integration'
REQUEST_LIMIT = 16384
DEADLINE = 15
METHODS = {
    'ping': {}, 'runtime.describe': {},
    'session.create': {'request_id': str, 'model': str},
    'session.resume': {'session_id': str},
    'session.info': {'session_id': str},
    'prompt.submit': {'session_id': str, 'input_id': str, 'text': str, 'workspace_epoch': str},
    'prompt.receipt': {'session_id': str, 'admission_id': str, 'include_result': bool},
    'session.interrupt': {'session_id': str, 'execution_generation': int},
    'session.new': {'session_id': str, 'request_id': str, 'revision': int, 'generation': int},
    'integrations.reload': {'session_id': object},
    'workspace.setup': {'descriptor': object, 'session_id': object}, 'workspace.stop': {},
}
CAPABILITIES = ['durable-admission-v1', 'event-replay-v1', 'local-cli-create-v1']
IDENTITY = {'session_id', 'stored_session_id', 'admission_id', 'input_id',
            'subscription_id', 'instance_id', 'authority_epoch',
            'execution_generation', 'generation', 'epoch', 'seq', 'sequence',
            'replay_epoch', 'last_sequence', 'revision', 'execution_state',
            'status', 'outcome', 'running'}


class Closed(Exception):
    pass


def emit(value):
    try:
        raw = (json.dumps(value, ensure_ascii=True, allow_nan=False,
                          separators=(',', ':')) + '\n').encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        raise Closed() from None
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def string(value, limit=512):
    return (type(value) is str and bool(value) and
            len(value.encode('utf-8')) <= limit)


def project(value, depth=0):
    """Exclude history, configuration, tool results and arbitrary nested data."""
    if type(value) is not dict or depth > 3:
        return {}
    out = {}
    for key in IDENTITY:
        item = value.get(key)
        if type(item) in (int, bool) or string(item):
            out[key] = item
    for key in ('ref', 'handle'):
        if type(value.get(key)) is dict:
            out[key] = project(value[key], depth + 1)
    if 'pending' in value:
        pending = value['pending']
        if type(pending) is not list or len(pending) > 64:
            raise Closed()
        out['pending'] = [project(item, depth + 1) for item in pending]
    return out


def text_fields(payload):
    out = project(payload)
    for key in ('text', 'delta'):
        if key in payload:
            value = payload[key]
            if type(value) is not str:
                raise Closed()
            out[key] = value
    return out


def validate(request):
    if type(request) is not dict or set(request) != {'id', 'method', 'params'}:
        raise ValueError()
    rid, method, params = request['id'], request['method'], request['params']
    if type(rid) is not int or not 0 < rid <= 9007199254740991:
        raise ValueError()
    if type(method) is not str or method not in METHODS or type(params) is not dict:
        raise ValueError()
    schema = METHODS[method]
    optional = {'prompt.receipt': {'include_result'}, 'prompt.submit': {'workspace_epoch'}}
    required = set(schema) - optional.get(method, set())
    if not required <= set(params) or set(params) - set(schema):
        raise ValueError()
    for key, value in params.items():
        if schema[key] is not object and type(value) is not schema[key]:
            raise ValueError()
        if type(value) is str and not string(value, REQUEST_LIMIT if key == 'text' else 512):
            raise ValueError()
        if key == 'text' and not value.strip():
            raise ValueError()
        if key in {'execution_generation', 'generation', 'revision'} and value < 0:
            raise ValueError()
    if method == 'integrations.reload' and params['session_id'] is not None and not string(params['session_id']):
        raise ValueError()
    if method == 'session.create' and params['model'] not in {'gpt-6.1-terra', 'gpt-6.1-sol'}:
        raise ValueError()
    return rid, method, params


def load_library():
    os.environ['HERMES_HOME'] = str(PROFILE)
    os.environ.pop('HERMES_TUI_GATEWAY_URL', None)
    # Preserve the interpreter's standard-library/site-package paths, not cwd/PYTHONPATH.
    roots = (Path(sys.base_prefix).resolve(), Path(sys.prefix).resolve())
    safe = []
    for entry in sys.path:
        if entry and any(Path(entry).resolve().is_relative_to(root) for root in roots):
            safe.append(entry)
    sys.path[:] = [INSTALL, str(INTEGRATION), *safe]
    spec = importlib.util.spec_from_file_location('_stellar_fixed_ivy', INTEGRATION / 'ivy_client.py')
    if spec is None or spec.loader is None:
        raise Closed()
    module = importlib.util.module_from_spec(spec)
    # Imports must never contaminate the JSONL channel.
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
        from hermes_cli.gateway_runtime import discover_gateway_endpoint
        from hermes_cli.gateway_client import connect_gateway
    return module.IvyConnection, discover_gateway_endpoint, connect_gateway


async def pump(conn, workspace=None, approvals=None):
    try:
        await pump_events(conn, workspace, approvals)
    finally:
        if approvals is not None:
            await approvals.cancel()


async def pump_events(conn, workspace, approvals):
    from stellar_ivy_activity import Activity
    activity = Activity()
    text_seen = {}
    while True:
        try:
            event = await asyncio.wait_for(conn.client.events.get(), activity.delay())
        except asyncio.TimeoutError:
            clean = activity.flush()
            if clean is not None:
                emit({'event': 'gateway', 'data': {'params': clean}})
            continue
        if isinstance(event, Exception) or type(event) is not dict:
            raise Closed()
        params = event.get('params')
        if type(params) is not dict:
            continue
        kind = params.get('type')
        if kind == 'approval.settled' and approvals is not None:
            await approvals.settle(params)
            continue
        if kind == 'message.delta':
            payload = params.get('payload')
            sid, admission = params.get('session_id'), params.get('admission_id')
            if (type(payload) is dict and type(payload.get('text')) is str and payload['text']
                    and string(sid) and string(admission) and (sid, admission) not in text_seen):
                if len(text_seen) >= 64:
                    text_seen.pop(next(iter(text_seen)))
                text_seen[(sid, admission)] = True
                pending = activity.flush()
                if pending is not None:
                    emit({'event': 'gateway', 'data': {'params': pending}})
                clean = project(params)
                clean.update(type='stellar.first_text', payload={'available': True})
                # Availability only. Raw deltas are not a committed user-facing text contract.
                emit({'event': 'gateway', 'data': {'params': clean}})
            continue
        if kind in {'tool.start', 'tool.complete'}:
            activity.offer(params)
            continue
        if kind not in {'message.complete', 'session.replay_gap',
                        'approval.request', 'clarify.request'}:
            continue
        # Terminal/control events retain ordering ahead of the next activity batch.
        pending = activity.flush()
        if pending is not None:
            emit({'event': 'gateway', 'data': {'params': pending}})
        payload = params.get('payload', {})
        if type(payload) is not dict:
            raise Closed()
        clean = project(params)
        clean['type'] = kind
        if kind in {'approval.request', 'clarify.request'}:
            clean['payload'] = {'present': True}
            if kind == 'approval.request':
                if approvals is not None:
                    approvals.offer(params)
                    continue
                sid = params.get('session_id')
                generation = payload.get('execution_generation', params.get('execution_generation'))
                prompt = payload.get('prompt_id')
                if not string(sid) or not string(prompt) or type(generation) is not int or generation < 0:
                    raise Closed()
                # Internal denial only; renderer cannot invoke approval.respond.
                await asyncio.wait_for(conn.client.rpc('approval.respond', session_id=sid,
                    execution_generation=generation, prompt_id=prompt, choice='deny'), DEADLINE)
        else:
            clean['payload'] = text_fields(payload) if kind.startswith('message.') else project(payload)
            if workspace is not None and type(clean['payload'].get('text')) is str:
                clean['payload']['text'] = workspace.redact(clean['payload']['text'])
        if kind == 'message.complete':
            if approvals is not None:
                await approvals.cancel(params.get('session_id'))
            admission = params.get('admission_id') or payload.get('admission_id')
            if not string(admission):
                raise Closed()
            # IvyConnection needs this for completion-before-submit-response races.
            # Bound its reconciliation set rather than accumulate notifications forever.
            if len(conn.completed) >= 256 and admission not in conn.completed:
                raise Closed()
            conn.completed.add(admission)
            if (conn.active and params.get('session_id') == conn.active['session_id']
                    and admission == conn.active.get('admission_id')):
                conn.active = None
                conn.lease.release(settled=True)
                if workspace is not None:
                    workspace.gate.disarm()
        # Retain native JSON-RPC envelope structure, not arbitrary envelope fields.
        envelope = {'params': clean}
        for key in ('jsonrpc', 'method'):
            if key in event:
                if not string(event[key], 128):
                    raise Closed()
                envelope[key] = event[key]
        emit({'event': 'gateway', 'data': envelope})


async def requests(conn):
    return await requests_with_workspace(conn, None)


async def read_requests(queue, workspace):
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline, REQUEST_LIMIT + 1)
            if not line:
                await queue.put(None)
                return
            if len(line) > REQUEST_LIMIT or not line.endswith(b'\n'):
                raise Closed()
            try:
                request = json.loads(line.decode('utf-8'), object_pairs_hook=pairs,
                                     parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                if type(request) is dict and request.get('control') == 'workspace_reply':
                    if workspace is None or set(request) != {'control', 'reply'}:
                        raise ValueError()
                    try:
                        workspace.gate.reply(request['reply'])
                    except Exception:
                        pass
                    continue
                if type(request) is dict and request.get('control') == 'workspace_disarm':
                    if set(request) != {'control'}:
                        raise ValueError()
                    if workspace is not None:
                        workspace.gate.disarm()
                    continue
                if type(request) is dict and request.get('control') == 'workspace_capture_failed':
                    if workspace is None or set(request) != {'control', 'header'}:
                        raise Closed()
                    try:
                        workspace.gate.reject_image(request['header'])
                    except Exception:
                        pass
                    continue
                await queue.put(validate(request))
            except (ValueError, UnicodeError, RecursionError):
                emit({'id': None, 'error': {'code': 'invalid_request'}})
    except asyncio.CancelledError:
        raise
    except Exception as error:
        await queue.put(error)


async def requests_with_workspace(conn, workspace, approvals=None):
    queue = asyncio.Queue(maxsize=4)
    reader = asyncio.create_task(read_requests(queue, workspace))
    try:
        await request_worker(conn, workspace, queue, approvals)
    finally:
        reader.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await reader


async def settle_receipt(conn, workspace, params, receipt, approvals=None):
    active = conn.active
    generation = receipt.get('execution_generation')
    if (type(active) is not dict or type(generation) is not int
            or generation < 0
            or active.get('session_id') != params['session_id']
            or active.get('admission_id') != params['admission_id']
            or receipt.get('admission_id') != params['admission_id']
            or receipt.get('ref', {}).get('session_id') != params['session_id']):
        return
    known = active.get('execution_generation')
    if known is not None and known != generation:
        return
    active['execution_generation'] = generation
    if (receipt.get('status') != 'terminal'
            or receipt.get('outcome') not in {'completed', 'failed', 'cancelled', 'interrupted'}):
        return
    if (receipt['outcome'] == 'completed'
            and type(receipt.get('result', {}).get('final_response')) is not str):
        return
    conn.active = None
    conn.lease.release(settled=True)
    if workspace is not None:
        workspace.gate.disarm()
    if approvals is not None:
        await approvals.cancel(params['session_id'])


async def request_worker(conn, workspace, queue, approvals=None):
    from stellar_ivy_controls import control, Refused
    from stellar_ivy_edit_policy import synchronize
    access = approvals.access if approvals is not None else {}
    while True:
        request = await queue.get()
        if request is None:
            return
        if isinstance(request, Exception):
            raise Closed() from None
        rid, method, params = request
        resuming = method == 'session.resume' and approvals is not None
        if resuming:
            conn.selected_session = None
            approvals.begin_resume(params['session_id'])
        try:
            if method in {'session.new', 'integrations.reload'}:
                result = await asyncio.wait_for(control(conn, method, params), DEADLINE)
            elif method == 'workspace.setup':
                if workspace is None:
                    raise Closed()
                result = await workspace.start(params['descriptor'])
                workspace.bind_session(params['session_id'])
            elif method == 'workspace.stop':
                if workspace is None:
                    raise Closed()
                await workspace.stop()
                result = {}
            elif method == 'session.create':
                # The installed IvyConnection excludes launch routing; keep its session registry
                # while invoking the gateway's explicitly advertised fixed-model contract.
                description = await asyncio.wait_for(conn.call('runtime.describe', {}), DEADLINE)
                fields = description.get('session_create', {}).get('parameters', [])
                if not {'model', 'provider'} <= set(fields):
                    raise Closed()
                options = {}
                if workspace is not None and workspace.task is not None:
                    if ('acp' not in description.get('session_create', {}).get('sources', []) or
                            not {'acp-editor-policy-v1', 'acp-session-mcp-v1'} <= set(description.get('capabilities', []))):
                        raise Closed()
                    options = {'editor': workspace.editor()}
                result = await asyncio.wait_for(conn.client.rpc(method, source='acp' if options else 'cli', cwd='D:/',
                    request_id=params['request_id'], model=params['model'], provider='openai-codex', **options), DEADLINE)
                sid = result.get('session_id')
                if not string(sid):
                    raise Closed()
                conn.sessions.add(sid)
                if options:
                    workspace.bind_session(sid)
                info = result.get('info', {})
                launch = info.get('launch_request', {})
                if (type(launch) is not dict or launch.get('model') != params['model'] or
                        launch.get('provider') != 'openai-codex' or info.get('model') != params['model']):
                    raise Closed()
                if options and not workspace.verifies(info):
                    raise Closed()
                if options:
                    result = await asyncio.wait_for(synchronize(conn.client, result, access), DEADLINE)
                    info = result.get('info', {})
                    if info.get('model') != params['model'] or not workspace.verifies(info):
                        raise Closed()
                result = {'session_id': sid, 'model': info['model']}
            elif method == 'session.resume' and workspace is not None and workspace.task is not None:
                description = await asyncio.wait_for(conn.call('runtime.describe', {}), DEADLINE)
                if 'acp-session-mcp-v1' not in description.get('capabilities', []):
                    raise Closed()
                result = await asyncio.wait_for(conn.call(method, params), DEADLINE)
                if not workspace.verifies(result.get('info', {})):
                    raise Closed()
                result = await asyncio.wait_for(synchronize(conn.client, result, access), DEADLINE)
            elif method == 'prompt.submit' and workspace is not None and workspace.task is not None:
                if workspace.owner_session != params['session_id'] or 'workspace_epoch' not in params:
                    raise Closed()
                epoch = params.pop('workspace_epoch')
                token = workspace.gate.arm(epoch, params['input_id'])
                workspace.remember_token(token)
                params['text'] = (f'For workspace tool calls in this turn, pass turn_token exactly as '
                                  f'{token}. Do not reveal the token. Do not reuse it in later turns.\n' + params['text'])
                result = await asyncio.wait_for(conn.call(method, params), DEADLINE)
                if result.get('admission_id') in conn.completed:
                    workspace.gate.disarm()
            else:
                params.pop('workspace_epoch', None)
                result = await asyncio.wait_for(conn.call(method, params), DEADLINE)
            if method == 'prompt.submit' and getattr(conn, 'active', None) is not None:
                conn.active['execution_generation'] = result.get('execution_generation')
            if method == 'prompt.receipt':
                await settle_receipt(conn, workspace, params, result, approvals)
            if method == 'workspace.setup':
                pass
            elif method == 'runtime.describe':
                if (type(result) is not dict or
                        os.path.normcase(result.get('profile_id', '')) != os.path.normcase(str(PROFILE)) or
                        not set(CAPABILITIES) <= set(result.get('capabilities', []))):
                    raise Closed()
                result = {'profile': 'ivy', 'protocol': 1, 'capabilities': CAPABILITIES}
            elif method == 'ping':
                if type(result) is not dict or result.get('pong') is not True:
                    raise Closed()
                result = {'pong': result['pong']}
            else:
                projected = project(result)
                if method == 'session.create':
                    projected['model'] = result['model']
                elif method == 'session.resume':
                    info = result.get('info', {})
                    if workspace is not None and workspace.task is not None and not workspace.verifies(info):
                        raise Closed()
                    if type(info) is dict and string(info.get('model')):
                        projected['model'] = info['model']
                if method == 'prompt.receipt' and result.get('status') == 'terminal':
                    saved = result.get('result')
                    if type(saved) is dict and type(saved.get('final_response')) is str:
                        final = saved['final_response']
                        if workspace is not None:
                            final = workspace.redact(final)
                        projected['result'] = {'final_response': text_fields({'text': final})['text']}
                result = projected
            if method in {'session.create', 'session.resume'}:
                conn.selected_session = result.get('session_id')
            if resuming:
                approvals.finish_resume(True)
            emit({'id': rid, 'result': result})
        except asyncio.TimeoutError:
            if workspace is not None:
                workspace.gate.disarm()
            emit({'id': rid, 'error': {'code': 'outcome_uncertain'}})
            raise Closed() from None
        except Refused as error:
            emit({'id': rid, 'error': {'code': error.code}})
        except Closed:
            if workspace is not None:
                workspace.gate.disarm()
            raise
        except Exception:
            if workspace is not None:
                workspace.gate.disarm()
            # Never retry: even a transport exception may follow admission.
            emit({'id': rid, 'error': {'code': 'outcome_uncertain'}})
            raise Closed() from None
        finally:
            if resuming:
                approvals.finish_resume(False)


async def serve():
    """Return 0 on EOF, 1 on fail-closed termination; host owns process deadline."""
    conn = None
    workspace = None
    tasks = []
    try:
        IvyConnection, discover, connect = load_library()
        from stellar_workspace_credentials import WorkspaceCredentials
        from stellar_workspace_protocol import WorkspaceGate
        from stellar_workspace_mcp import make_server
        from stellar_workspace_service import WorkspaceService
        from stellar_ivy_approvals import Approvals, load_access
        access = load_access(PROFILE)
        try:
            import win32cred
        except ImportError:
            win32cred = None
        if win32cred is not None:
            workspace = WorkspaceService(WorkspaceCredentials(win32cred), WorkspaceGate(emit), make_server)
        found = await asyncio.to_thread(discover, PROFILE, timeout=2)
        if found.state != 'ready' or found.endpoint is None or found.endpoint.runtime_protocol != 1:
            raise Closed()
        # Discovery validates home and loopback; explicit endpoint forbids autostart.
        async with connect(found.endpoint) as client:
            conn = IvyConnection(client, approvals=bool(access))
            if workspace is not None:
                conn.client = workspace.wrap_client(conn.client)
            approvals = Approvals(conn.client, lambda: getattr(conn, 'selected_session', None), access) if access else None
            tasks = [asyncio.create_task(pump(conn, workspace, approvals)), asyncio.create_task(requests_with_workspace(conn, workspace, approvals))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            return 0
    except asyncio.CancelledError:
        raise
    except Exception:
        return 1
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if conn is not None:
            conn.lease.release()
        if workspace is not None:
            await workspace.stop()


if __name__ == '__main__':
    os._exit(asyncio.run(serve()))
