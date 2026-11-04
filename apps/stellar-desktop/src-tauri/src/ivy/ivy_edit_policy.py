"""Project the host owner's edit consent into the gateway's inherited session policy."""
import uuid


async def synchronize(client, snapshot, access):
    info = snapshot.get('info', {})
    if info.get('source') != 'acp':
        return snapshot
    desired = 'session' if access.get('file_edits') == 'all' else 'ask'
    if info.get('edit_approval_policy') == desired:
        return snapshot
    # A running execution keeps the policy it was admitted with; sync before the next turn.
    if snapshot.get('running') is True or snapshot.get('pending'):
        return snapshot
    sid = snapshot.get('session_id')
    revision, generation = snapshot.get('revision'), snapshot.get('execution_generation')
    if (type(sid) is not str or not sid or snapshot.get('running') is not False
            or snapshot.get('pending') != [] or type(revision) is not int or revision < 0
            or type(generation) is not int or generation < 0):
        raise ValueError('Cannot fence the session edit policy')
    changed = await client.rpc('session.mutate', session_id=sid,
        request_id='stellar-edit-policy-' + uuid.uuid4().hex,
        expected_revision=revision, expected_generation=generation,
        operation='edit_policy', payload={'policy': desired})
    if changed.get('session_id') != sid or changed.get('operation') != 'edit_policy':
        raise ValueError('Mismatched edit-policy receipt')
    current = await client.rpc('session.resume', session_id=sid)
    if (current.get('session_id') != sid
            or current.get('info', {}).get('edit_approval_policy') != desired):
        raise ValueError('Session edit policy was not confirmed')
    return current
