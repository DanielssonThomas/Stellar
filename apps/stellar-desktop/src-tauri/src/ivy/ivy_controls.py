"""Fixed, non-inference controls against the installed canonical owner gateway."""
import json


class Refused(Exception):
    def __init__(self, code):
        self.code = code


async def settled_lease(conn):
    record = conn.lease.record
    if not record.exists():
        return
    if record.stat().st_size > 4096:
        raise Refused('busy')
    saved = json.loads(record.read_text(encoding='utf-8'))
    if (type(saved) is not dict or not all(type(saved.get(k)) is str and 0 < len(saved[k]) <= 512
                                          for k in ('session_id', 'admission_id'))):
        raise Refused('busy')
    await conn.client.rpc('session.resume', session_id=saved['session_id'])
    receipt = await conn.client.rpc('prompt.receipt', session_id=saved['session_id'], admission_id=saved['admission_id'])
    if (receipt.get('status') != 'terminal' or receipt.get('admission_id') != saved['admission_id'] or
            receipt.get('ref', {}).get('session_id') != saved['session_id']):
        raise Refused('busy')
    # The writer lock remains held until the control completes.
    record.unlink()


async def control(conn, method, params):
    sid = params.get('session_id')
    if sid is not None and sid not in conn.sessions:
        raise Refused('unavailable')
    if conn.active:
        raise Refused('busy')
    # Share the installed Ivy client's writer exclusion; never clear another client's lease.
    try:
        conn.lease.acquire()
    except (ValueError, OSError):
        raise Refused('busy') from None
    try:
        await settled_lease(conn)
        if method == 'integrations.reload':
            if sid is not None:
                before = await conn.client.rpc('session.resume', session_id=sid)
                if before.get('session_id') != sid or type(before.get('pending')) is not list or type(before.get('running')) is not bool:
                    raise Refused('unavailable')
                if before.get('running') or before.get('pending'):
                    raise Refused('busy')
            result = await conn.client.rpc('reload.mcp', confirm=True, **({'session_id': sid} if sid else {}))
            if result.get('status') != 'reloaded':
                raise Refused('unavailable')
            if result.get('session') == 'busy':
                raise Refused('busy')
            if result.get('unavailable'):
                raise Refused('unavailable')
            if sid and result.get('session') not in {'applied', 'unchanged'}:
                raise Refused('unavailable')
            return {'status': 'reloaded'}
        result = await conn.client.rpc('session.mutate', session_id=sid,
            request_id=params['request_id'], expected_revision=params['revision'],
            expected_generation=params['generation'], operation='reset', payload={})
        target, previous = result.get('target_session_id'), result.get('previous_target_session_id')
        if (result.get('operation') != 'reset' or result.get('session_id') != sid or
                type(target) is not str or not target or type(previous) is not str or not previous or target == previous or
                type(result.get('execution_generation')) is not int or
                result['execution_generation'] <= params['generation']):
            raise Refused('uncertain')
        # This reads the actual backend context after the committed reset, not a cleared UI.
        fresh = await conn.client.rpc('session.resume', session_id=sid)
        if (fresh.get('session_id') != sid or fresh.get('messages') != [] or
                fresh.get('message_count') != 0 or fresh.get('running') is not False or
                fresh.get('pending') != [] or fresh.get('execution_generation') != result['execution_generation']):
            raise Refused('uncertain')
        return {'status': 'fresh', 'execution_generation': result['execution_generation']}
    finally:
        conn.lease.release()
