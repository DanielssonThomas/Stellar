"""Pinned host call sites. Missing composition/producer is denial, including cold recovery."""
from __future__ import annotations

import json

from .contract import CAPABILITY, ContractError, canonical, closed


def reserved(row):
    payload = row.get('payload') if 'payload' in row else json.loads(row['payload_json'])
    return (str(row['request_id']).startswith(CAPABILITY + ':')
            or 'background_v1' in (payload.get('local_automation_v1') or {}))


def guard(db, conn, row):
    if not reserved(row):
        return
    from hermes_state_runtime import RuntimeStoreError
    host = getattr(db, '_stellar_background_host', None)
    if host is None:
        raise RuntimeStoreError('admission_conflict', field='background_v1', detail='host wiring unavailable')
    try:
        host.ledger_for_row(conn, row).guard_claim(conn, row)
    except ContractError as exc:
        raise RuntimeStoreError('admission_conflict', field='background_v1', detail=exc.code) from None


def terminal_allowed(db, conn, row):
    if not reserved(row):
        return True
    try:
        guard(db, conn, row)
        return True
    except Exception as exc:
        from hermes_state_runtime import RuntimeStoreError
        if (not isinstance(exc, RuntimeStoreError) or exc.reason != 'admission_conflict'
                or exc.field != 'background_v1'):
            raise  # uncertain storage/generation failures are not a manufactured terminal result
        return False


def display(payload, card):
    descriptor = (payload.get('local_automation_v1') or {}).get('background_v1')
    if descriptor is not None:
        # This function is called only on a claimed canonical row; the claim guard proved custody.
        if (card.get('display_kind') != 'lifecycle_update' or type(descriptor) is not dict
                or descriptor.get('capability') != CAPABILITY):
            raise ContractError('untrusted_descriptor')
        return {**card, 'background_v1': json.loads(canonical(descriptor))}
    return card


def receipt(connection, ref, admission_id, out):
    """Called after ordinary prompt.receipt authorization. Read exact saved descriptor, never text."""
    from hermes_state_runtime import get_session_admission
    row = get_session_admission(connection.authority.db, admission_id=admission_id)
    if row is None or not reserved(row):
        return out
    host = getattr(connection.authority.db, '_stellar_background_host', None)
    if host is None:
        return {**out, 'background_delivery_authorized': False}
    with host.authority.db._read_ctx() as conn:
        ledger = host.ledger_for_row(conn, row)
        saved = conn.execute('SELECT * FROM stellar_bg_events_v1 WHERE request_id=?', (row['request_id'],)).fetchone()
        owner = host.consumer(connection, ref.session_id, saved['binding_id'])
        value = owner.call('inspect', {'eventId': saved['event_id'], 'digest': saved['digest']})
    # Existing receipt may deliberately show the claim while publication is settling. Do not
    # turn the independent DB lookup into an early terminal completion visible to the consumer.
    authorized = (out['status'] == 'terminal' and value.get('deliveryAuthorized') is True
                  and value.get('receipt', {}).get('admission_id') == admission_id)
    return {**out, 'background_v1': value['descriptor'], 'background_delivery_authorized': authorized}


async def dispatch(connection, request):
    """Closed native-only host methods; no producer RPC, profile redirect or Origin deserializer."""
    from functools import partial
    from hermes_state_runtime import RuntimeStoreError
    from gateway.session_runtime_workers import tracked_write
    ident, params = request.get('id'), request.get('params') or {}
    try:
        host = getattr(connection.authority.db, '_stellar_background_host', None)
        if host is None:
            raise ContractError('host_wiring_unavailable')
        method = request['method'].removeprefix('stellar.background.')
        if method == 'bind':
            closed(params, ('session_id', 'consentTicket'))
            operation = partial(host.bind, connection, params['session_id'], params['consentTicket'])
        else:
            keys = {'inspect': ('eventId', 'digest'), 'revoke': (),
                    'effect.begin': ('eventId', 'digest', 'operation', 'kind'),
                    'effect.finish': ('eventId', 'operation', 'kind')}
            if method not in keys:
                raise ContractError('unknown_method')
            closed(params, ('session_id', 'bindingId', *keys[method]))
            consumer = host.consumer(connection, params['session_id'], params['bindingId'])
            operation = partial(consumer.call, method, {k: params[k] for k in keys[method]})
        result = await tracked_write(connection.authority, operation)
        return {'jsonrpc': '2.0', 'id': ident, 'result': result}
    except (ContractError, RuntimeStoreError) as exc:
        reason = exc.code if isinstance(exc, ContractError) else exc.reason
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': 4001, 'message': reason,
                'data': {'reason': reason, 'retryAuthorized': False}}}
