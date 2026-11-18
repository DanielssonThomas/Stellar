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
from ivy_retained_test import Connection, Workspace, retained


def connection(audit=None):
    conn = Connection()
    conn.sessions = {'current'}
    conn.client.info['attached'] = True
    original = conn.client.rpc

    async def rpc(method, **params):
        result = await original(method, **params)
        if audit is not None:
            Path(audit).write_text(json.dumps({
                'methods': [m for m, _ in conn.client.calls],
                'mutations': len(conn.client.mutations),
                'requests': [{'request_id': p['request_id'], 'revision': p['expected_revision'],
                              'generation': p['expected_generation'], 'operation': p['operation']}
                             for p in conn.client.mutations.values()],
                'history': conn.client.history,
            }))
        return result

    async def call(method, params):
        return await rpc(method, **params)

    conn.client.rpc = rpc
    conn.call = call
    return conn


async def serve(audit=None, mode=None):
    bridge.PROFILE = 'fixture'
    conn, workspace, queue = connection(audit), Workspace(), asyncio.Queue()
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
