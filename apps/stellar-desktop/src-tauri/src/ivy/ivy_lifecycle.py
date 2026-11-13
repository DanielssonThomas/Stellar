"""Closed consumer projection for the inactive ba49247 producer contract.

These validators confer no user grant or render/speech effect authority.
"""
from __future__ import annotations

CAPABILITY = 'stellar.background.v1'
CONTRACT_SHA256 = '008c72c917a981672e4ff5e08e54780484c784169cf91d2757fc62dc283ec724'
INTERFACE_SHA256 = '392c027ac8a5ba92873b1d0958a255bfb6cdd73f2a11b5d7b8ac3b97f066821e'
SAFE = 2**53 - 1
ORIGIN = {'profileId', 'sessionId', 'physicalTarget', 'route', 'producerId', 'workerIncarnation'}
DESCRIPTOR = {'schemaVersion', 'capability', 'kind', 'bindingId', 'eventId', 'digest', 'origin',
              'consentRevision', 'expiresAt', 'maxAdmissions', 'eventExpiresAt'}
BINDING = {'bindingId', 'origin', 'consentRevision', 'expiresAt', 'maxAdmissions', 'spent', 'revoked', 'createdAt'}


def closed(value, fields):
    if type(value) is not dict or set(value) != fields:
        raise ValueError('invalid background contract')


def integer(value, low=0, high=SAFE):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('invalid background integer')


def identifier(value, limit):
    if (type(value) is not str or not value or len(value.encode('utf-8', errors='strict')) > limit
            or any(not c.isprintable() or c.isspace() for c in value)):
        raise ValueError('invalid background identifier')


def hexadecimal(value, length):
    if type(value) is not str or len(value) != length or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('invalid background digest')


def origin(value, profile, session):
    closed(value, ORIGIN)
    for item in value.values():
        identifier(item, 512)
    hexadecimal(value['workerIncarnation'], 32)
    if value['profileId'] != profile or value['sessionId'] != session:
        raise ValueError('foreign background origin')


def descriptor(value, profile, session):
    closed(value, DESCRIPTOR)
    integer(value['schemaVersion'], 1, 1)
    if value['capability'] != CAPABILITY or value['kind'] != 'lifecycle_update':
        raise ValueError('unsupported background contract')
    hexadecimal(value['bindingId'], 32)
    hexadecimal(value['digest'], 64)
    identifier(value['eventId'], 256)
    origin(value['origin'], profile, session)
    integer(value['consentRevision'], 1)
    integer(value['expiresAt'], 1)
    integer(value['eventExpiresAt'], 1, value['expiresAt'])
    integer(value['maxAdmissions'], 1, 100)
    return value


def bindings(value, profile, session):
    closed(value, {'bindings'})
    rows = value['bindings']
    if type(rows) is not list or len(rows) > 20:
        raise ValueError('invalid background bindings')
    seen = set()
    for row in rows:
        closed(row, BINDING)
        origin(row['origin'], profile, session)
        hexadecimal(row['bindingId'], 32)
        if row['bindingId'] in seen or type(row['revoked']) is not bool:
            raise ValueError('invalid background binding')
        seen.add(row['bindingId'])
        integer(row['consentRevision'], 1)
        integer(row['createdAt'])
        integer(row['expiresAt'], row['createdAt'] + 1, min(SAFE, row['createdAt'] + 604800000))
        integer(row['maxAdmissions'], 1, 100)
        integer(row['spent'], 0, row['maxAdmissions'])
    return value


def inspection(value, profile, session, request):
    fields = {'schemaVersion', 'descriptor', 'status', 'retryAuthorized', 'deliveryAuthorized', 'receipt'}
    if type(value) is not dict or set(value) not in (fields, fields - {'receipt'},
            {'schemaVersion', 'status', 'retryAuthorized'}):
        raise ValueError('invalid background inspection')
    integer(value['schemaVersion'], 1, 1)
    if value['retryAuthorized'] is not False or value['status'] not in ('unknown', 'admitted', 'terminal'):
        raise ValueError('invalid background status')
    if 'descriptor' in value:
        card = descriptor(value['descriptor'], profile, session)
        if any(card[k] != request[k] for k in ('bindingId', 'eventId', 'digest')):
            raise ValueError('background identity conflict')
        if type(value['deliveryAuthorized']) is not bool:
            raise ValueError('invalid background authority')
    elif value['status'] != 'unknown':
        raise ValueError('missing background descriptor')
    if value['status'] == 'unknown' and value.get('deliveryAuthorized', False) is not False:
        raise ValueError('unknown background authority')
    receipt = value.get('receipt')
    if receipt is None:
        if value['status'] != 'unknown':
            raise ValueError('missing background receipt')
        return value
    required = {'admission_id', 'ref', 'status', 'outcome', 'sequence', 'authority_epoch', 'execution_generation'}
    if type(receipt) is not dict or set(receipt) not in (required, required | {'result'}):
        raise ValueError('invalid background receipt')
    identifier(receipt['admission_id'], 512)
    closed(receipt['ref'], {'profile_id', 'session_id'})
    if receipt['ref'] != {'profile_id': profile, 'session_id': session}:
        raise ValueError('foreign background receipt')
    integer(receipt['sequence'], 1)
    for key in ('authority_epoch', 'execution_generation'):
        if receipt[key] is not None:
            integer(receipt[key])
    if value['status'] == 'admitted':
        if receipt['status'] not in ('queued', 'started') or receipt['outcome'] is not None or 'result' in receipt or value['deliveryAuthorized']:
            raise ValueError('invalid admitted receipt')
    elif value['status'] == 'terminal':
        if receipt['status'] != 'terminal' or receipt['outcome'] not in ('completed', 'failed', 'cancelled', 'interrupted'):
            raise ValueError('invalid terminal receipt')
    if 'result' in receipt:
        closed(receipt['result'], {'final_response'})
        final = receipt['result']['final_response']
        if type(final) is not str or len(final.encode('utf-8', errors='strict')) > 262144:
            raise ValueError('invalid background result')
    if value.get('deliveryAuthorized'):
        if (value['status'] != 'terminal' or receipt['outcome'] != 'completed'
                or not receipt.get('result', {}).get('final_response', '').strip()
                or any(receipt[k] is None for k in ('authority_epoch', 'execution_generation'))):
            raise ValueError('invalid delivery authority')
    return value


async def call(conn, method, params, profile, deadline):
    import asyncio
    if (not getattr(conn, 'background_v1', False)
            or params['session_id'] != getattr(conn, 'selected_session', None)):
        raise ValueError('background transport unavailable')
    if method == 'stellar.background.bind':
        hexadecimal(params['consentTicket'], 64)
    else:
        hexadecimal(params['bindingId'], 32)
        if 'eventId' in params:
            identifier(params['eventId'], 256)
        if 'digest' in params:
            hexadecimal(params['digest'], 64)
        if 'operation' in params:
            hexadecimal(params['operation'], 32)
            if params['kind'] not in ('render', 'speech'):
                raise ValueError('invalid background effect kind')
    result = await asyncio.wait_for(conn.client.rpc(method, **params), deadline)
    if method.endswith('.bind'):
        bindings({'bindings': [result]}, profile, params['session_id'])
    elif method.endswith('.inspect'):
        inspection(result, profile, params['session_id'], params)
    elif method.endswith('.begin'):
        closed(result, {'status', 'execute'})
        if type(result['execute']) is not bool or (result['status'], result['execute']) not in (
                ('claimed', True), ('unknown', False), ('finished', False)):
            raise ValueError('invalid background effect claim')
    else:
        closed(result, {'status', 'revocationCommitted', 'effectsStopped'})
        if (type(result['revocationCommitted']) is not bool or type(result['effectsStopped']) is not bool
                or (result['status'], result['revocationCommitted'], result['effectsStopped']) not in (
                    ('active', False, False), ('revoking', True, False), ('revoked', True, True))):
            raise ValueError('invalid background stop acknowledgement')
    return result


def canonical_receipt(value, profile, session):
    if type(value) is not dict or 'background_v1' not in value or type(value.get('background_delivery_authorized')) is not bool:
        raise ValueError('background receipt proof unavailable')
    card = descriptor(value['background_v1'], profile, session)
    fields = {'admission_id', 'ref', 'status', 'outcome', 'sequence', 'authority_epoch', 'execution_generation', 'result'}
    receipt = {k: v for k, v in value.items() if k in fields}
    inspection({'schemaVersion': 1, 'status': 'terminal' if value.get('status') == 'terminal' else 'admitted',
        'retryAuthorized': False, 'descriptor': card, 'deliveryAuthorized': value['background_delivery_authorized'],
        'receipt': receipt}, profile, session, card)
    return {**receipt, 'background_v1': card, 'background_delivery_authorized': value['background_delivery_authorized']}
