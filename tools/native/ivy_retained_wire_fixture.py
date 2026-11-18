"""Real private bridge dispatch/JSONL with inert external gateway and workspace peers.

No installed Hermes imports, profile files, credentials, model calls or real tools.
"""
import asyncio
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ivy_bridge_test import bridge
from ivy_retained_test import Connection, NativeBindingClient, owned_workspace, retained

Workspace = owned_workspace


def connection(audit=None, mode=None):
    conn = Connection()
    conn.client = NativeBindingClient()
    conn.sessions = {'current'}
    conn.client.info['attached'] = True
    if mode == 'policy-preserved':
        conn.client.info['edit_approval_policy'] = 'workspace_session'
    conn.client.state.update(replay_epoch='epoch', last_sequence=7)
    original = conn.client.rpc
    replay_failed = False

    async def rpc(method, **params):
        nonlocal replay_failed
        assert 'preserve_policy' not in params, 'private option must not reach native API'
        if method == 'session.events.since':
            conn.client.calls.append((method, params))
            if mode == 'replay-fail-once' and not replay_failed:
                replay_failed = True
                raise retained.Refused('unavailable')
            events = []
            if mode in {'replay', 'replay-fail-once'}:
                events = [{'session_id': 'retained', 'admission_id': 'missed',
                           'authority_epoch': 1, 'execution_generation': 2,
                           'replay_epoch': 'epoch', 'seq': 6, 'type': 'message.start',
                           'payload': {'autonomous': True}}]
            result = {'events': events, 'replay_epoch': 'epoch',
                      'last_sequence': 7, 'truncated': False}
        elif method == 'prompt.receipt':
            conn.client.calls.append((method, params))
            result = {'ref': {'session_id': 'retained'}, 'admission_id': 'missed',
                      'authority_epoch': 1, 'execution_generation': 2, 'sequence': 6,
                      'status': 'terminal', 'outcome': 'completed',
                      'result': {'final_response': 'Retained background answer'}}
        else:
            result = await original(method, **params)
        if audit is not None:
            Path(audit).write_text(json.dumps({
                'methods': [m for m, _ in conn.client.calls],
                'mutations': len(conn.client.mutations),
                'requests': [{'request_id': p['request_id'], 'revision': p['expected_revision'],
                              'generation': p['expected_generation'], 'operation': p['operation']}
                             for p in conn.client.mutations.values()],
                'history': conn.client.history,
                'policy': conn.client.info['edit_approval_policy'],
            }))
        return result

    async def call(method, params):
        return await rpc(method, **params)

    conn.client.rpc = rpc
    conn.call = call
    return conn


async def serve(audit=None, mode=None):
    bridge.PROFILE = 'fixture'
    conn, workspace, queue = connection(audit, mode), Workspace(), asyncio.Queue()
    conn.client = workspace.wrap_client(conn.client)
    async def call(method, params):
        return await conn.client.rpc(method, **params)
    conn.call = call
    if mode == 'lost-commit-reply':
        original_commit = retained.commit
        first = True

        async def lose_once(*args):
            nonlocal first
            result = await original_commit(*args)
            if first:
                first = False
                result['model'] = 'invalid-post-effect-model'
            return result

        retained.commit = lose_once

    async def feed():
        while raw := await asyncio.to_thread(sys.stdin.buffer.readline):
            # Same parser/schema and worker/emit path as the embedded private bridge.
            request = bridge.validate(json.loads(raw, object_pairs_hook=bridge.pairs))
            await queue.put(request)
        await queue.put(None)

    await asyncio.gather(feed(), bridge.request_worker(conn, workspace, queue))


if __name__ == '__main__':
    asyncio.run(serve(sys.argv[1] if len(sys.argv) > 1 else None, sys.argv[2] if len(sys.argv) > 2 else None))
