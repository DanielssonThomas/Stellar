"""Authenticated attach fence + read-only discovery + canonical per-ID recovery reads."""
import asyncio

from stellar_ivy_notifications import closed, uint, text
from stellar_ivy_recovery_store import inventory, LIMIT


def snapshot(value, profile, sid):
    if (type(value) is not dict or value.get('session_id') != sid
            or value.get('stored_session_id') != sid
            or value.get('info', {}).get('profile_id') != str(profile)):
        raise ValueError('recovery_scope')
    result = {'session_id':sid, 'profile_id':str(profile)}
    for name in ('authority_epoch','execution_generation','revision','last_sequence'):
        result[name] = uint(value.get(name))
    result['replay_epoch'] = text(value.get('replay_epoch'), 512)
    return result


async def recover(conn, params, profile, deadline, replay):
    closed(params, {'session_id','after_sequence','retained'})
    sid = text(params['session_id'], 512)
    floor = uint(params['after_sequence'])
    retained = params['retained']
    if type(retained) is not list or len(retained) > 24 or len(set(retained)) != len(retained):
        raise ValueError('recovery_retained')
    for item in retained:
        text(item, 512)
    client = conn.client
    def current():
        if conn.client is not client or getattr(conn, 'selected_session', None) != sid:
            raise ValueError('recovery_selection_changed')
    current()
    timer = getattr(conn, 'notification_reconciler', None)
    if timer is not None:
        timer.pause()
    async with asyncio.timeout(deadline):
        first = snapshot(await client.rpc('session.resume', session_id=sid), profile, sid)
        physical, rows = await asyncio.to_thread(inventory, profile, first)
        entries = []
        found = set()
        for row in rows:
            if row['sequence'] <= floor and row['admission_id'] not in retained:
                continue
            value = await client.rpc('prompt.receipt', session_id=sid,
                                     admission_id=row['admission_id'], include_result=True)
            if (type(value) is not dict or value.get('ref') != {'profile_id':str(profile),'session_id':sid}
                    or value.get('admission_id') != row['admission_id']
                    or value.get('sequence') != row['sequence']
                    or value.get('execution_generation') != row['generation']
                    or value.get('authority_epoch') != row['authority']):
                raise ValueError('recovery_receipt_conflict')
            if 'background_v1' in value or 'background_delivery_authorized' in value:
                raise ValueError('recovery_lifecycle_receipt')
            receipt = {k:value[k] for k in ('admission_id','ref','sequence','status','outcome',
                                           'authority_epoch','execution_generation')}
            found.add(row['admission_id'])
            entries.append({'receipt':receipt, 'input_id':row['input_id'],
                            'kind':row['kind'], 'descriptor':row['descriptor']})
        if not set(retained) <= found or len(entries) > LIMIT:
            raise ValueError('recovery_retained_missing')
        last = snapshot(await client.rpc('session.resume', session_id=sid), profile, sid)
        if any(first[k] != last[k] for k in first if k != 'last_sequence') or last['last_sequence'] < first['last_sequence']:
            raise ValueError('recovery_fence_changed')
        tail = await replay(conn, {'session_id':sid, 'replay_epoch':first['replay_epoch'],
                                   'last_sequence':first['last_sequence']})
        if tail.get('truncated') is not False or tail.get('replay_epoch') != first['replay_epoch']:
            raise ValueError('recovery_tail_gap')
        current()
    if timer is not None:
        timer.select(sid)
    return {'snapshot':{**first, 'physical_session_id':physical}, 'entries':entries, 'tail':tail}
