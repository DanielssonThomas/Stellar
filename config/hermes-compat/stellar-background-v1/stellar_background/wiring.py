"""Pinned host call sites. Missing composition/producer is denial, including cold recovery."""
from __future__ import annotations

import json
import hashlib
from pathlib import Path

from .contract import CAPABILITY, ContractError, canonical, closed

CONTRACT_SHA256 = '008c72c917a981672e4ff5e08e54780484c784169cf91d2757fc62dc283ec724'
INTERFACE_SHA256 = '392c027ac8a5ba92873b1d0958a255bfb6cdd73f2a11b5d7b8ac3b97f066821e'


def negotiation(out):
    """A: reserve exact transport fields, but never advertise this unqualified candidate.

    Genuine native/consumer activation is a separate gate. Neither model JSON, caller flags,
    fixture verifiers nor the installation package can set a positive runtime capability here.
    """
    if hashlib.sha256((Path(__file__).resolve().parents[1] / 'contract-v1.json').read_bytes()).hexdigest() != CONTRACT_SHA256:
        raise ContractError('contract_mismatch')
    if hashlib.sha256((Path(__file__).resolve().parents[1] / 'host-interface-v1.json').read_bytes()).hexdigest() != INTERFACE_SHA256:
        raise ContractError('interface_mismatch')
    result = {**out, 'capabilities': [v for v in out.get('capabilities', []) if v != CAPABILITY]}
    result.pop('background_v1_contract_sha256', None)
    result.pop('background_v1_interface_sha256', None)
    return result


def row_descriptor(row):
    payload = row.get('payload') if 'payload' in row else json.loads(row['payload_json'])
    card = (payload.get('local_automation_v1') or {}).get('background_v1')
    if (type(card) is not dict or card.get('capability') != CAPABILITY
            or card.get('kind') != 'lifecycle_update' or card.get('schemaVersion') != 1):
        from hermes_state_runtime import RuntimeStoreError
        raise RuntimeStoreError('permission_denied', field='background_v1', detail='descriptor unavailable')
    return json.loads(canonical(card))


def completion(row, settled, complete):
    if not reserved(row):
        return complete
    # The input is the exact canonical claimed row, not arbitrary model output or a display flag.
    return {**complete, 'display_kind': 'lifecycle_update', 'background_v1': row_descriptor(row)}


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
        return {**out, 'background_v1': row_descriptor(row), 'background_delivery_authorized': False}
    with host.authority.db._read_ctx() as conn:
        host.ledger_for_row(conn, row)
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
        then = None
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
            consumer = host.consumer(connection, params['session_id'], params['bindingId'],
                capability='session:read' if method == 'inspect' else 'session:control')
            operation = partial(consumer.call, method, {k: params[k] for k in keys[method]})
            if method == 'revoke':
                then = lambda result: host.settle_cancellations(params['bindingId'], result)
        result = await tracked_write(connection.authority, operation, then=then)
        return {'jsonrpc': '2.0', 'id': ident, 'result': result}
    except (ContractError, RuntimeStoreError) as exc:
        reason = exc.code if isinstance(exc, ContractError) else exc.reason
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': 4001, 'message': reason,
                'data': {'reason': reason, 'retryAuthorized': False}}}
