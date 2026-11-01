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
OUTPUT_LIMIT = 65536
DEADLINE = 15
METHODS = {
    'ping': {}, 'runtime.describe': {},
    'session.create': {'request_id': str},
    'session.resume': {'session_id': str},
    'session.info': {'session_id': str},
    'prompt.submit': {'session_id': str, 'input_id': str, 'text': str},
    'prompt.receipt': {'session_id': str, 'admission_id': str, 'include_result': bool},
    'session.interrupt': {'session_id': str, 'execution_generation': int},
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
    if len(raw) > OUTPUT_LIMIT:
        raise Closed()
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
            if type(value) is not str or len(value.encode('utf-8')) > REQUEST_LIMIT:
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
    required = set(schema) - ({'include_result'} if method == 'prompt.receipt' else set())
    if not required <= set(params) or set(params) - set(schema):
        raise ValueError()
    for key, value in params.items():
        if type(value) is not schema[key]:
            raise ValueError()
        if type(value) is str and not string(value, REQUEST_LIMIT if key == 'text' else 512):
            raise ValueError()
        if key == 'text' and not value.strip():
            raise ValueError()
        if key == 'execution_generation' and value < 0:
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


async def pump(conn):
    while True:
        event = await conn.client.events.get()
        if isinstance(event, Exception) or type(event) is not dict:
            raise Closed()
        params = event.get('params')
        if type(params) is not dict:
            continue
        kind = params.get('type')
        if kind not in {'message.complete', 'session.replay_gap',
                        'approval.request', 'clarify.request'}:
            continue
        payload = params.get('payload', {})
        if type(payload) is not dict:
            raise Closed()
        clean = project(params)
        clean['type'] = kind
        if kind in {'approval.request', 'clarify.request'}:
            clean['payload'] = {'present': True}
            if kind == 'approval.request':
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
        if kind == 'message.complete':
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
        # Retain native JSON-RPC envelope structure, not arbitrary envelope fields.
        envelope = {'params': clean}
        for key in ('jsonrpc', 'method'):
            if key in event:
                if not string(event[key], 128):
                    raise Closed()
                envelope[key] = event[key]
        emit({'event': 'gateway', 'data': envelope})


async def requests(conn):
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline, REQUEST_LIMIT + 1)
        if not line:
            return
        if len(line) > REQUEST_LIMIT or not line.endswith(b'\n'):
            raise Closed()
        rid = None
        try:
            request = json.loads(line.decode('utf-8'), object_pairs_hook=pairs,
                                 parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            rid, method, params = validate(request)
        except (ValueError, UnicodeError, RecursionError):
            emit({'id': None, 'error': {'code': 'invalid_request'}})
            continue
        try:
            result = await asyncio.wait_for(conn.call(method, params), DEADLINE)
            if method == 'runtime.describe':
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
                if method == 'prompt.receipt' and result.get('status') == 'terminal':
                    saved = result.get('result')
                    if type(saved) is dict and type(saved.get('final_response')) is str:
                        projected['result'] = {'final_response': text_fields({'text': saved['final_response']})['text']}
                result = projected
            emit({'id': rid, 'result': result})
        except asyncio.TimeoutError:
            emit({'id': rid, 'error': {'code': 'outcome_uncertain'}})
            raise Closed() from None
        except Closed:
            raise
        except Exception:
            # Never retry: even a transport exception may follow admission.
            emit({'id': rid, 'error': {'code': 'outcome_uncertain'}})
            raise Closed() from None


async def serve():
    """Return 0 on EOF, 1 on fail-closed termination; host owns process deadline."""
    conn = None
    tasks = []
    try:
        IvyConnection, discover, connect = load_library()
        found = await asyncio.to_thread(discover, PROFILE, timeout=2)
        if found.state != 'ready' or found.endpoint is None or found.endpoint.runtime_protocol != 1:
            raise Closed()
        # Discovery validates home and loopback; explicit endpoint forbids autostart.
        async with connect(found.endpoint) as client:
            conn = IvyConnection(client, approvals=False)
            tasks = [asyncio.create_task(pump(conn)), asyncio.create_task(requests(conn))]
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


if __name__ == '__main__':
    os._exit(asyncio.run(serve()))
