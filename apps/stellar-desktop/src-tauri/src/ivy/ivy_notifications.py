"""Closed candidate notification data; neither a permission nor an effect lease."""
import copy
import asyncio
import hashlib
import json
import math


BINDING_FIELDS = {'binding_id', 'profile_id', 'session_id', 'owner_session_id', 'session_key',
                  'plugin_id', 'tracking_id', 'revision', 'expires_at'}
IDENTITY_FIELDS = ('profile_id', 'session_id', 'owner_session_id', 'session_key', 'plugin_id', 'tracking_id')
MARKER_FIELDS = {'schema_version', 'binding', 'event_id', 'payload_digest'}
RECEIPT_FIELDS = {'admission_id', 'ref', 'sequence', 'status', 'outcome',
                  'authority_epoch', 'execution_generation'}


def closed(value, fields):
    if type(value) is not dict or set(value) != fields:
        raise ValueError('notification_shape')
    return value


def text(value, limit=1024):
    if type(value) is not str or not value or '\0' in value:
        raise ValueError('notification_text')
    try:
        if len(value.encode('utf-8')) > limit:
            raise ValueError('notification_text')
    except UnicodeError:
        raise ValueError('notification_text') from None
    return value


def uint(value):
    if type(value) is not int or not 0 <= value <= 2**64 - 1:
        raise ValueError('notification_integer')
    return value


def digest(value):
    if type(value) is not str or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('notification_digest')
    return value


def binding(value, profile, session, plugin):
    closed(value, BINDING_FIELDS)
    for key in BINDING_FIELDS - {'revision', 'expires_at'}:
        text(value[key])
    expiry = value['expires_at']
    try:
        finite_expiry = type(expiry) in (int, float) and math.isfinite(expiry) and expiry > 0
    except OverflowError:
        finite_expiry = False
    if uint(value['revision']) == 0 or not finite_expiry:
        raise ValueError('notification_revision')
    identity = {key: value[key] for key in IDENTITY_FIELDS}
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if (digest(value['binding_id']) != hashlib.sha256(encoded).hexdigest()
            or value['profile_id'] != profile or value['owner_session_id'] != session
            or value['plugin_id'] != plugin):
        raise ValueError('notification_owner')
    return copy.deepcopy(value)


def marker(value, profile, session, plugin):
    closed(value, MARKER_FIELDS)
    if type(value['schema_version']) is not int or value['schema_version'] != 1:
        raise ValueError('notification_version')
    binding(value['binding'], profile, session, plugin)
    text(value['event_id'], 256)
    digest(value['payload_digest'])
    return copy.deepcopy(value)


def inspection(value, expected, admission):
    scope = expected['binding']
    context = (scope['profile_id'], scope['owner_session_id'], scope['plugin_id'])
    marker(expected, *context)
    unknown = value.get('status') == 'unknown' if type(value) is dict else False
    fields = {'status', 'binding', 'event_id', 'delivery_allowed'}
    closed(value, fields if unknown else fields | {'descriptor', 'receipt', 'result'})
    binding(value['binding'], *context)
    if (value['binding'] != expected['binding'] or value['event_id'] != expected['event_id']
            or type(value['delivery_allowed']) is not bool):
        raise ValueError('notification_conflict')
    if unknown:
        if value['delivery_allowed']:
            raise ValueError('notification_unknown')
        return copy.deepcopy(value)
    if value['status'] != 'known':
        raise ValueError('notification_status')
    notice = value['descriptor']
    if notice is not None:
        marker(notice, *context)
    if notice is not None and notice != expected:
        raise ValueError('notification_conflict')
    receipt = closed(value['receipt'], RECEIPT_FIELDS)
    ref = closed(receipt['ref'], {'profile_id', 'session_id'})
    if (ref['profile_id'] != expected['binding']['profile_id']
            or ref['session_id'] != expected['binding']['owner_session_id']
            or (admission is not None and receipt['admission_id'] != admission)):
        raise ValueError('notification_receipt')
    text(receipt['admission_id'], 512)
    uint(receipt['sequence'])
    uint(receipt['authority_epoch'])
    generation = receipt['execution_generation']
    if generation is not None:
        uint(generation)
    status, outcome = receipt['status'], receipt['outcome']
    if type(status) is not str or status not in {'queued', 'started', 'terminal', 'unknown'}:
        raise ValueError('notification_receipt')
    if status == 'queued' and generation is not None:
        raise ValueError('notification_receipt')
    if status == 'started' and generation is None:
        raise ValueError('notification_receipt')
    if outcome is not None and (type(outcome) is not str or outcome not in {'completed', 'failed', 'cancelled', 'interrupted', 'rejected'}):
        raise ValueError('notification_receipt')
    if (status == 'terminal' and outcome is None) or (status != 'terminal' and outcome is not None):
        raise ValueError('notification_receipt')
    if status == 'terminal' and outcome == 'completed' and generation is None:
        raise ValueError('notification_receipt')
    result = value['result']
    if result is not None and type(result) is not dict:
        raise ValueError('notification_result')
    inner = result.get('result') if type(result) is dict else None
    if type(result) is dict and 'result' in result and type(inner) is not dict:
        raise ValueError('notification_result')
    if type(inner) is dict and 'final_response' in inner and type(inner['final_response']) is not str:
        raise ValueError('notification_result')
    if value['delivery_allowed']:
        if notice is None or status != 'terminal' or outcome != 'completed' or generation is None:
            raise ValueError('notification_delivery')
    return copy.deepcopy(value)


def revocation(value, profile, session, plugin):
    closed(value, {'plugin_id', 'binding', 'in_flight'})
    if value['plugin_id'] != plugin:
        raise ValueError('notification_plugin')
    binding(value['binding'], profile, session, plugin)
    active = value['in_flight']
    if type(active) is not list or len(active) > 1024:
        raise ValueError('notification_inflight')
    for item in active:
        text(item, 512)
    if len(set(active)) != len(active):
        raise ValueError('notification_inflight')
    return copy.deepcopy(value)


def forwarded(value, expected, admission):
    closed(value, {'host', 'local_eligible', 'delivery_allowed'})
    host = inspection(value['host'], expected, admission)
    local, allowed = value['local_eligible'], value['delivery_allowed']
    if type(local) is not bool or type(allowed) is not bool:
        raise ValueError('notification_eligibility')
    inner = (host.get('result') or {}).get('result')
    final = inner.get('final_response') if type(inner) is dict else None
    meaningful = type(final) is str and bool(final.strip()) and len(final.encode('utf-8')) <= 262144
    if allowed != (host['status'] == 'known' and local and host['delivery_allowed'] and meaningful):
        raise ValueError('notification_eligibility')
    if host['status'] == 'known':
        inner = (host['result'] or {}).get('result')
        final = inner.get('final_response') if type(inner) is dict else None
        host['result'] = {'result': {'final_response': final}} if type(final) is str else None
    return {'host': host, 'local_eligible': local, 'delivery_allowed': allowed}


async def inspect_forward(conn, params, profile, deadline):
    closed(params, {'session_id', 'admission_id', 'descriptor'})
    if params['session_id'] != getattr(conn, 'selected_session', None):
        raise ValueError('notification_selected_session')
    notice = marker(params['descriptor'], profile, params['session_id'], 'stellar-herdr')
    digest(notice['event_id'])
    text(params['admission_id'], 512)
    try:
        response = await asyncio.wait_for(conn.client.rpc('plugin.stellar-herdr.observations.inspect',
            session_id=params['session_id'], event_id=notice['event_id']), deadline)
    except Exception as error:
        if isinstance(error, getattr(conn, 'rpc_error_type', ())):
            from stellar_ivy_controls import Refused
            raise Refused('unavailable') from None
        raise
    result = forwarded(response, notice, params['admission_id'])
    retain(conn, params['session_id'], params['admission_id'], notice)
    return result


def retain(conn, session, admission, notice):
    saved = getattr(conn, 'notification_admissions', None)
    if saved is None:
        saved = conn.notification_admissions = {}
    key = (session, admission)
    if key in saved and saved[key] != notice:
        raise ValueError('notification_conflict')
    if len(saved) >= 24 and key not in saved:
        retired = getattr(conn, 'notification_completed', set())
        old = next((key for key in saved if key in retired), None)
        if old is None:
            raise ValueError('notification_capacity')
        del saved[old]
        retired.discard(old)
    saved[key] = notice


def event_payload(conn, payload, session, admission, kind, profile):
    known = getattr(conn, 'notification_admissions', {}).get((session, admission))
    if 'background_v1' in payload and ('plugin_notification' in payload or known is not None):
        raise ValueError('notification_protocol_conflict')
    if 'plugin_notification' not in payload and known is None:
        return None
    if session != getattr(conn, 'selected_session', None):
        raise ValueError('notification_selected_session')
    text(admission, 512)
    if kind == 'message.start':
        if payload.get('display_kind') != 'internal_notification' or payload.get('notification_category') == 'diagnostic':
            raise ValueError('notification_display')
        notice = marker(payload.get('plugin_notification'), profile, session, 'stellar-herdr')
        digest(notice['event_id'])
        if known is not None and known != notice:
            raise ValueError('notification_conflict')
        retain(conn, session, admission, notice)
        return {'plugin_notification': notice}
    if kind == 'message.complete' and known is not None:
        if 'plugin_notification' in payload and payload['plugin_notification'] != known:
            raise ValueError('notification_conflict')
        if not hasattr(conn, 'notification_completed'):
            conn.notification_completed = set()
        conn.notification_completed.add((session, admission))
        return {'plugin_notification': known}
    raise ValueError('notification_unretained')
