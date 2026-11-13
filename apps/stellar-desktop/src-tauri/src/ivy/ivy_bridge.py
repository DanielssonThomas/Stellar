"""Fixed attach-only JSONL bridge. Host imports and awaits serve(); no CLI."""
from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading

sys.dont_write_bytecode = True
PROFILE = Path('D:/Hermes/profiles/ivy')
INSTALL = 'D:/Hermes/hermes-agent'
INTEGRATION = PROFILE / 'integration'
REQUEST_LIMIT = 65536
DEADLINE = 15
METHODS = {
    'ping': {}, 'runtime.describe': {},
    'session.create': {'request_id': str, 'model': str},
    'session.resume': {'session_id': str},
    'session.info': {'session_id': str},
    'session.events.since': {'session_id': str, 'replay_epoch': str, 'last_sequence': int},
    'prompt.submit': {'session_id': str, 'input_id': str, 'text': str, 'workspace_epoch': str,
                      'observation': dict, 'voice_expression': dict},
    'prompt.receipt': {'session_id': str, 'admission_id': str, 'include_result': bool},
    'stellar.notification.inspect': {'session_id': str, 'admission_id': str, 'descriptor': dict},
    'stellar.notification.reconcile': {'session_id': str},
    'stellar.session.recover': {'session_id': str, 'after_sequence': int, 'retained': list},
    'stellar.background.bind': {'session_id': str, 'consentTicket': str},
    'stellar.background.inspect': {'session_id': str, 'bindingId': str, 'eventId': str, 'digest': str},
    'stellar.background.revoke': {'session_id': str, 'bindingId': str},
    'stellar.background.effect.begin': {'session_id': str, 'bindingId': str, 'eventId': str, 'digest': str, 'operation': str, 'kind': str},
    'stellar.background.effect.finish': {'session_id': str, 'bindingId': str, 'eventId': str, 'operation': str, 'kind': str},
    'session.interrupt': {'session_id': str, 'execution_generation': int},
    'clarify.respond': {'session_id': str, 'execution_generation': int, 'prompt_id': str, 'answer': str},
    'session.new': {'session_id': str, 'request_id': str, 'revision': int, 'generation': int},
    'integrations.reload': {'session_id': object},
    'workspace.setup': {'descriptor': object, 'session_id': object}, 'workspace.stop': {},
    'inspector.inspect': {'active': object, 'requested': object, 'offset': int, 'before': object},
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
    optional = {'prompt.receipt': {'include_result'}, 'prompt.submit': {'workspace_epoch', 'observation', 'voice_expression'}}
    required = set(schema) - optional.get(method, set())
    if not required <= set(params) or set(params) - set(schema):
        raise ValueError()
    for key, value in params.items():
        if schema[key] is not object and type(value) is not schema[key]:
            raise ValueError()
        if key == 'answer' and method == 'clarify.respond':
            if len(value.encode('utf-8')) > 16384 or any(ord(c) < 32 and c not in '\n\r\t' for c in value):
                raise ValueError()
            continue
        if type(value) is str and not string(value, 16384 if key == 'text' else 512):
            raise ValueError()
        if key == 'text' and not value.strip():
            raise ValueError()
        if key in {'execution_generation', 'generation', 'revision', 'last_sequence'} and value < 0:
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
        if getattr(conn, 'notification_reconciler', None) is not None:
            await conn.notification_reconciler.close()
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
        if kind == 'plugin.stellar-herdr.notification.revoked':
            if params.get('session_id') != getattr(conn, 'selected_session', None):
                continue
            from stellar_ivy_notifications import revocation
            try:
                revoked = revocation(params.get('payload'), str(PROFILE), params['session_id'], 'stellar-herdr')
            except ValueError:
                raise Closed() from None
            if getattr(conn, 'notification_reconciler', None) is not None:
                conn.notification_reconciler.invalidate()
            clean = project(params)
            clean.update(type=kind, payload=revoked)
            emit({'event': 'gateway', 'data': {'params': clean}})
            continue
        known = getattr(conn, 'lifecycle_admissions', {}).get((params.get('session_id'), params.get('admission_id')))
        notification_known = getattr(conn, 'notification_admissions', {}).get((params.get('session_id'), params.get('admission_id')))
        if notification_known is not None and kind not in {'message.start', 'message.complete'}:
            continue
        if known is not None and kind not in {'message.start', 'message.complete'}:
            # No lifecycle interim/tool/question content gains foreground authority.
            continue
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
        if kind not in {'message.start', 'message.interim', 'message.complete', 'session.replay_gap',
                        'approval.request', 'clarify.request', 'clarify.settled'}:
            continue
        # Terminal/control events retain ordering ahead of the next activity batch.
        pending = activity.flush()
        if pending is not None:
            emit({'event': 'gateway', 'data': {'params': pending}})
        payload = params.get('payload', {})
        if type(payload) is not dict:
            raise Closed()
        if ('plugin_notification' in payload and getattr(conn, 'selected_session', None) is not None
                and params.get('session_id') != conn.selected_session):
            continue
        notification = notification_payload(conn, payload, params.get('session_id'), params.get('admission_id'), kind)
        if notification is None:
            guard_plugin_notification(payload)
        clean = project(params)
        clean['type'] = kind
        lifecycle = lifecycle_payload(conn, payload, params.get('session_id'), params.get('admission_id'), kind) if notification is None and kind in {'message.start', 'message.complete'} else None
        if notification is not None:
            clean['payload'] = notification
        elif lifecycle is not None:
            clean['payload'] = lifecycle
        elif kind == 'message.start':
            clean['payload'] = {'autonomous': autonomous_start(payload)}
        elif kind == 'message.interim':
            text, streamed = payload.get('text'), payload.get('already_streamed')
            if not string(text, 4096) or type(streamed) is not bool:
                continue
            if workspace is not None:
                text = workspace.redact(text)
            clean['payload'] = {'text': text, 'already_streamed': streamed}
        elif kind in {'clarify.request', 'clarify.settled'}:
            prompt = payload.get('prompt_id')
            if not string(prompt):
                raise Closed()
            clean['payload'] = {'prompt_id': prompt}
            if kind == 'clarify.request':
                question, choices = payload.get('question'), payload.get('choices')
                multi = payload.get('multi_select')
                if (not string(question, 32768) or type(choices) is not list or len(choices) > 4
                        or any(not string(choice, 8192) for choice in choices) or type(multi) is not bool):
                    raise Closed()
                clean['payload'].update(question=question, choices=choices, multi_select=multi)
        elif kind == 'approval.request':
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
            if kind == 'message.complete':
                clean['payload'] = completion_payload(payload)
            if workspace is not None and type(clean['payload'].get('text')) is str:
                clean['payload']['text'] = workspace.redact(clean['payload']['text'])
        if kind == 'message.complete' and lifecycle is None and notification is None:
            if (approvals is not None and conn.active
                    and params.get('session_id') == conn.active.get('session_id')
                    and params.get('admission_id') == conn.active.get('admission_id')):
                await approvals.cancel(params.get('session_id'))
            admission = params.get('admission_id') or payload.get('admission_id')
            if not string(admission):
                raise Closed()
            # IvyConnection needs this for completion-before-submit-response races.
            # Bound its reconciliation set rather than accumulate notifications forever.
            if (conn.active and params.get('session_id') == conn.active.get('session_id')
                    and conn.active.get('admission_id') in {None, admission}):
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


def completion_payload(payload):
    clean = text_fields(payload)
    if type(payload.get('response_reused')) is bool:
        clean['response_reused'] = payload['response_reused']
    return clean


def lifecycle_private_text(result, workspace):
    if workspace is None:
        return
    receipt = result.get('receipt', result)
    final = receipt.get('result', {}).get('final_response') if type(receipt) is dict else None
    # Preserve exact canonical comparisons without exposing native MCP tokens.
    # A modified canonical answer is not equivalent proof: refuse it entirely.
    if type(final) is str and workspace.redact(final) != final:
        raise Closed()


def guard_plugin_notification(payload):
    if 'plugin_notification' in payload:
        # A host marker must use the closed notification projection.
        # Never erase a host marker and checkpoint it as an ordinary answer.
        raise Closed()


def notification_payload(conn, payload, session, admission, kind):
    from stellar_ivy_notifications import event_payload
    try:
        return event_payload(conn, payload, session, admission, kind, str(PROFILE))
    except ValueError:
        raise Closed() from None


def autonomous_start(payload):
    guard_plugin_notification(payload)
    if payload.get('display_kind') == 'lifecycle_update':
        # Do not discard a future version's consent/receipt proof or advance past it.
        # Delivery remains disabled until end-to-end revocation is implemented.
        raise Closed()
    # Ordinary admitted turns have no display card. This is only a receipt candidate:
    # native excludes the foreground admission and verifies the canonical answer.
    return (payload.get('display_kind') in {None, 'async_delegation_complete', 'process_complete'}
            and payload.get('notification_category') != 'diagnostic')


def lifecycle_payload(conn, payload, session, admission=None, kind=None):
    known = getattr(conn, 'lifecycle_admissions', {}).get((session, admission))
    if known is not None and 'background_v1' not in payload and kind == 'message.complete':
        if not getattr(conn, 'background_v1', False) or session != getattr(conn, 'selected_session', None):
            raise Closed()
        # A terminal trigger only: native re-inspects its retained canonical tuple.
        return {'background_v1': known}
    if payload.get('display_kind') != 'lifecycle_update' and 'background_v1' not in payload:
        return None
    from stellar_ivy_lifecycle import descriptor
    if (not getattr(conn, 'background_v1', False) or session != getattr(conn, 'selected_session', None)
            or not string(session) or payload.get('display_kind') != 'lifecycle_update'
            or payload.get('notification_category') == 'diagnostic'):
        raise Closed()
    card = descriptor(payload.get('background_v1'), str(PROFILE), session)
    if admission is not None:
        if not string(admission) or (known is not None and known != card):
            raise Closed()
        retained = getattr(conn, 'lifecycle_admissions', None)
        if retained is None:
            retained = conn.lifecycle_admissions = {}
        if len(retained) >= 16 and (session, admission) not in retained:
            raise Closed()
        retained[(session, admission)] = card
    return {'background_v1': card}


async def replay_events(conn, params, workspace):
    if params['session_id'] != getattr(conn, 'selected_session', None):
        raise Closed()
    result = await asyncio.wait_for(conn.client.rpc('session.events.since', **params), DEADLINE)
    if (type(result) is dict and result.get('truncated') is True
            and result.get('snapshot_required') is True and result.get('events') == []
            and string(result.get('replay_epoch')) and type(result.get('last_sequence')) is int
            and result['last_sequence'] >= 0):
        return {'events':[], 'truncated':True, 'snapshot_required':True,
                'replay_epoch':result['replay_epoch'], 'last_sequence':result['last_sequence']}
    if (type(result) is not dict or type(result.get('events')) is not list
            or len(result['events']) > 1024 or type(result.get('truncated')) is not bool
            or result.get('replay_epoch') != params['replay_epoch']
            or type(result.get('last_sequence')) is not int or result['last_sequence'] < params['last_sequence']):
        raise Closed()
    events = []
    for event in result['events']:
        if type(event) is not dict or event.get('session_id') != params['session_id']:
            raise Closed()
        kind, payload = event.get('type'), event.get('payload')
        if kind not in {'message.start', 'message.complete', 'plugin.stellar-herdr.notification.revoked'}:
            continue
        if type(payload) is not dict:
            raise Closed()
        if kind == 'plugin.stellar-herdr.notification.revoked':
            from stellar_ivy_notifications import revocation
            try:
                revoked = revocation(payload, str(PROFILE), params['session_id'], 'stellar-herdr')
            except ValueError:
                raise Closed() from None
            if getattr(conn, 'notification_reconciler', None) is not None:
                conn.notification_reconciler.invalidate()
            clean = project(event)
            clean.update(type=kind, payload=revoked)
            events.append(clean)
            continue
        notification = notification_payload(conn, payload, params['session_id'], event.get('admission_id'), kind)
        if notification is None:
            guard_plugin_notification(payload)
        clean = project(event)
        clean['type'] = kind
        lifecycle = lifecycle_payload(conn, payload, params['session_id'], event.get('admission_id'), kind) if notification is None else None
        clean['payload'] = (notification if notification is not None else lifecycle if lifecycle is not None else
            {'autonomous': autonomous_start(payload)} if kind == 'message.start' else completion_payload(payload))
        if workspace is not None and type(clean['payload'].get('text')) is str:
            clean['payload']['text'] = workspace.redact(clean['payload']['text'])
        events.append(clean)
    return {'events': events, 'replay_epoch': result['replay_epoch'],
            'last_sequence': result['last_sequence'], 'truncated': result['truncated']}


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
                    if workspace is None or set(request) not in ({'control', 'header'}, {'control', 'header', 'reason'}):
                        raise Closed()
                    try:
                        workspace.gate.reject_image(request['header'], request.get('reason', 'capture_unavailable'))
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
        if getattr(conn, 'notification_reconciler', None) is not None:
            await conn.notification_reconciler.close()
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


async def profile_toolsets():
    """One daemon per create; cancellation closes the bridge, never retries loading.

    Python cannot cancel a synchronous import. The native broker owns the bridge
    process and kills/reaps it on failure; the daemon must not hold interpreter
    shutdown or the asyncio default executor open. Late results are discarded.
    """
    loop = asyncio.get_running_loop()
    result = loop.create_future()

    def publish(value, error):
        if not result.done():
            if error is None:
                result.set_result(value)
            else:
                result.set_exception(Closed())

    def load():
        try:
            from stellar_ivy_profile_tools import load_toolsets
            value, error = load_toolsets(), None
        except BaseException:
            value, error = None, True
        try:
            loop.call_soon_threadsafe(publish, value, error)
        except RuntimeError:
            pass  # The owning bridge already closed its event loop.

    threading.Thread(target=load, name='ivy-profile-tools', daemon=True).start()
    return await result


def failure_diagnostic(conn, error):
    # These labels never establish rejection: an RPC error can follow admission.
    if isinstance(error, getattr(conn, 'rpc_error_type', ())):
        return {
            'permission_denied': 'owner_permission', 'invalid_params': 'owner_parameters',
            'busy': 'owner_busy', 'storage_unavailable': 'owner_storage',
            'admission_conflict': 'owner_conflict', 'not_found': 'owner_missing',
            'runtime_draining': 'owner_draining',
        }.get(str(error), 'owner_other')
    if isinstance(error, ValueError):
        return {
            'Ivy has an active client operation; resume it or wait.': 'client_writer_busy',
            'Previous operation is unsettled; resume/cancel it before submitting new work': 'client_pending',
            'Previous submission outcome unknown; inspect its session before clearing runtime/ivy-client/active.json': 'client_unknown',
            'Unsupported method or parameter': 'client_parameters',
        }.get(str(error), 'bridge_local')
    return 'bridge_local'


async def request_worker(conn, workspace, queue, approvals=None):
    from stellar_ivy_controls import control, Refused
    from stellar_ivy_edit_policy import synchronize
    from stellar_ivy_conversation import submit_conversation
    access = approvals.access if approvals is not None else {}
    while True:
        request = await queue.get()
        if request is None:
            return
        if isinstance(request, Exception):
            raise Closed() from None
        rid, method, params = request
        reconciler = getattr(conn, 'notification_reconciler', None)
        if method in {'session.create', 'session.resume', 'session.new', 'workspace.stop'}:
            if reconciler is not None:
                reconciler.pause()
        if method == 'runtime.describe':
            conn.background_v1 = False
        resuming = method == 'session.resume' and approvals is not None
        if resuming:
            conn.selected_session = None
            approvals.begin_resume(params['session_id'])
        try:
            if method == 'stellar.session.recover':
                from stellar_ivy_recovery import recover
                result = await recover(conn, params, PROFILE, DEADLINE,
                    lambda peer, cursor: replay_events(peer, cursor, workspace))
            elif method == 'stellar.notification.reconcile':
                if reconciler is None:
                    raise Refused('unavailable')
                result = await reconciler.forward(params)
            elif method == 'stellar.notification.inspect':
                from stellar_ivy_notifications import inspect_forward
                result = await inspect_forward(conn, params, str(PROFILE), DEADLINE)
                final = (((result.get('host') or {}).get('result') or {}).get('result') or {}).get('final_response')
                if workspace is not None and type(final) is str and workspace.redact(final) != final:
                    raise Closed()
            elif method.startswith('stellar.background.'):
                from stellar_ivy_lifecycle import call
                result = await call(conn, method, params, str(PROFILE), DEADLINE)
                lifecycle_private_text(result, workspace)
            elif method == 'inspector.inspect':
                from stellar_ivy_inspector import Inspector
                inspector = getattr(conn, 'inspector', None)
                if inspector is None:
                    inspector = conn.inspector = Inspector(PROFILE)
                active = params['active']
                if getattr(conn, 'selected_session', None) is not None and active != conn.selected_session:
                    raise Closed()
                requested, offset, before = params['requested'], params['offset'], params['before']
                if ((requested is not None and not string(requested, 512)) or
                        not 0 <= offset <= 1960 or
                        (before is not None and (type(before) is not int or not 0 < before <= 4294967295))):
                    raise Closed()
                result = await inspector.inspect(conn, active, requested, offset, before,
                    workspace.redact if workspace is not None else lambda value: value)
            elif method in {'session.new', 'integrations.reload'}:
                result = await asyncio.wait_for(control(conn, method, params), DEADLINE)
            elif method == 'session.events.since':
                result = await replay_events(conn, params, workspace)
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
                async with asyncio.timeout(DEADLINE):
                    # The installed IvyConnection excludes launch routing; keep its session registry
                    # while invoking the gateway's explicitly advertised fixed-model contract.
                    description = await asyncio.wait_for(conn.call('runtime.describe', {}), DEADLINE)
                    fields = description.get('session_create', {}).get('parameters', [])
                    if not {'model', 'provider'} <= set(fields):
                        raise Closed()
                    options = {}
                    if workspace is not None and workspace.task is not None:
                        if ('acp' not in description.get('session_create', {}).get('sources', []) or
                                'toolsets' not in fields or
                                not {'acp-editor-policy-v1', 'acp-session-mcp-v1'} <= set(description.get('capabilities', []))):
                            raise Closed()
                        options = {'editor': workspace.editor(), 'toolsets': await profile_toolsets()}
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
                    if options and launch.get('toolsets') != options['toolsets']:
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
            elif method == 'prompt.submit':
                epoch = params.pop('workspace_epoch', None)
                token = None
                if workspace is not None and workspace.task is not None:
                    if workspace.owner_session != params['session_id'] or epoch is None:
                        raise Closed()
                    token = workspace.gate.arm(epoch, params['input_id'])
                    workspace.remember_token(token)

                def expression_current():
                    active = workspace.gate.active if token is not None else None
                    return token is None or (active is not None and active[2] == token)

                result = await asyncio.wait_for(
                    submit_conversation(conn, params, workspace_token=token, profile=PROFILE,
                                        expression_current=expression_current), DEADLINE)
                if token is not None and result.get('admission_id') in conn.completed:
                    workspace.gate.disarm()
            else:
                params.pop('workspace_epoch', None)
                result = await asyncio.wait_for(conn.call(method, params), DEADLINE)
            if method == 'prompt.submit' and getattr(conn, 'active', None) is not None:
                conn.active['execution_generation'] = result.get('execution_generation')
            if method == 'prompt.receipt':
                if type(result) is dict and ('background_v1' in result or 'background_delivery_authorized' in result):
                    from stellar_ivy_lifecycle import canonical_receipt
                    if (not getattr(conn, 'background_v1', False)
                            or params['session_id'] != getattr(conn, 'selected_session', None)):
                        raise Closed()
                    result = canonical_receipt(result, str(PROFILE), params['session_id'])
                    lifecycle_private_text(result, workspace)
                else:
                    await settle_receipt(conn, workspace, params, result, approvals)
            if method in {'workspace.setup', 'session.events.since', 'inspector.inspect', 'stellar.notification.inspect', 'stellar.notification.reconcile', 'stellar.session.recover',
                          *[m for m in METHODS if m.startswith('stellar.background.')]} or (
                          method == 'prompt.receipt' and 'background_v1' in result):
                pass
            elif method == 'runtime.describe':
                if (type(result) is not dict or
                        os.path.normcase(result.get('profile_id', '')) != os.path.normcase(str(PROFILE)) or
                        not set(CAPABILITIES) <= set(result.get('capabilities', []))):
                    raise Closed()
                from stellar_ivy_lifecycle import CONTRACT_SHA256, INTERFACE_SHA256
                advertised = 'stellar.background.v1' in result.get('capabilities', [])
                if advertised and (result.get('background_v1_contract_sha256') != CONTRACT_SHA256
                        or result.get('background_v1_interface_sha256') != INTERFACE_SHA256):
                    raise Closed()
                conn.background_v1 = advertised
                result = {'profile': 'ivy', 'protocol': 1,
                          'capabilities': [*CAPABILITIES, *(['stellar.background.v1'] if conn.background_v1 else [])],
                          **({'background_v1_contract_sha256': CONTRACT_SHA256,
                              'background_v1_interface_sha256': INTERFACE_SHA256} if conn.background_v1 else {})}
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
                        if type(saved.get('response_reused')) is bool:
                            projected['result']['response_reused'] = saved['response_reused']
                result = projected
            if method in {'session.create', 'session.resume'}:
                conn.selected_session = result.get('session_id')
                if reconciler is not None:
                    if (not string(conn.selected_session) or
                            (method == 'session.resume' and conn.selected_session != params['session_id'])):
                        raise Closed()
                    reconciler.select(conn.selected_session)
            if resuming:
                approvals.finish_resume(True)
            emit({'id': rid, 'result': result})
        except asyncio.TimeoutError:
            if workspace is not None:
                workspace.gate.disarm()
            emit({'id': rid, 'error': {'code': 'outcome_uncertain', 'diagnostic': 'deadline'}})
            raise Closed() from None
        except Refused as error:
            emit({'id': rid, 'error': {'code': error.code}})
        except Closed:
            if workspace is not None:
                workspace.gate.disarm()
            raise
        except Exception as error:
            if workspace is not None:
                workspace.gate.disarm()
            # Never retry: even a transport exception may follow admission.
            emit({'id': rid, 'error': {'code': 'outcome_uncertain',
                                       'diagnostic': failure_diagnostic(conn, error)}})
            raise Closed() from None
        finally:
            if resuming:
                approvals.finish_resume(False)


async def serve():
    """Return 0 on EOF, 1 on fail-closed termination; host owns process deadline."""
    conn = None
    workspace = None
    tasks = []
    prime_config = None
    try:
        IvyConnection, discover, connect = load_library()
        from stellar_workspace_credentials import WorkspaceCredentials
        from stellar_workspace_protocol import WorkspaceGate
        from stellar_workspace_mcp import make_server
        from stellar_workspace_service import WorkspaceService
        from stellar_ivy_approvals import Approvals, load_access
        from stellar_ivy_conversation import ConversationClient
        from stellar_ivy_reconcile import Reconciler
        from stellar_ivy_voice_expression import installed, native_codex_transport
        from hermes_cli.gateway_client import GatewayRPCError
        try:
            from tools.voice_mode_transcript import is_voice_stop_phrase
        except ImportError:
            is_voice_stop_phrase = None
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
            conn.rpc_error_type = GatewayRPCError
            if workspace is not None:
                conn.client = workspace.wrap_client(conn.client)
            conn.client = ConversationClient(conn.client, GatewayRPCError, is_voice_stop_phrase)
            conn.notification_reconciler = Reconciler(conn, DEADLINE, lambda error: failure_diagnostic(conn, error))
            if installed(PROFILE):
                prime_config = asyncio.create_task(asyncio.to_thread(native_codex_transport))
            approvals = Approvals(conn.client, lambda: getattr(conn, 'selected_session', None), access) if access else None
            tasks = [asyncio.create_task(pump(conn, workspace, approvals)), asyncio.create_task(requests_with_workspace(conn, workspace, approvals)),
                     asyncio.create_task(conn.notification_reconciler.run())]
            done, _ = await asyncio.wait(tasks[:2], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            return 0
    except asyncio.CancelledError:
        raise
    except Exception:
        return 1
    finally:
        if prime_config is not None:
            prime_config.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await prime_config
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if conn is not None:
            if getattr(conn, 'notification_reconciler', None) is not None:
                await conn.notification_reconciler.close()
            conn.lease.release()
            if getattr(conn, 'inspector', None) is not None:
                await conn.inspector.close()
        if workspace is not None:
            await workspace.stop()


if __name__ == '__main__':
    os._exit(asyncio.run(serve()))
