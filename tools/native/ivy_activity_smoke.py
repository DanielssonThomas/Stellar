"""Opt-in, attach-only qualification; creates an empty test conversation, never submits a prompt."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'apps/stellar-desktop/src-tauri/src/ivy'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SOURCE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def main():
    bridge = load('bridge', 'ivy_bridge.py')
    controls = load('controls', 'ivy_controls.py')
    connection, discover, connect = bridge.load_library()
    found = await asyncio.to_thread(discover, bridge.PROFILE, timeout=2)
    if found.state != 'ready' or found.endpoint is None:
        raise RuntimeError('No existing ready gateway; qualification will not start one')
    async with connect(found.endpoint) as client:
        description = await client.rpc('runtime.describe')
        before_instance = description['instance_id']
        created = await client.rpc('session.create', source='cli', cwd='D:/',
            request_id='stellar-activity-smoke-' + uuid.uuid4().hex,
            model='gpt-6.1-sol', provider='openai-codex', title='Stellar lifecycle qualification')
        sid = created['session_id']
        conn = connection(client, approvals=False)
        conn.sessions.add(sid)
        try:
            before = await client.rpc('session.resume', session_id=sid)
            reset = await controls.control(conn, 'session.new', {'session_id': sid,
                'request_id': 'stellar-reset-smoke-' + uuid.uuid4().hex,
                'revision': before['revision'], 'generation': before['execution_generation']})
            after = await client.rpc('session.resume', session_id=sid)
            report = {
                'schema_version': 1, 'prompt_submissions': 0,
                'fresh_context_confirmed': reset['status'] == 'fresh' and after['messages'] == [] and after['message_count'] == 0,
                'generation_advanced': after['execution_generation'] > before['execution_generation'],
                'logical_session_preserved': before['session_id'] == after['session_id'],
                'model_preserved': before['info']['model'] == after['info']['model'] == 'gpt-6.1-sol',
                'reload_checked': '--reload' in sys.argv,
            }
            if '--reload' in sys.argv:
                reload = await controls.control(conn, 'integrations.reload', {'session_id': sid})
                report['reload_confirmed'] = reload['status'] == 'reloaded'
            report['same_runtime'] = (await client.rpc('runtime.describe'))['instance_id'] == before_instance
            if not all(v for k, v in report.items() if k not in {'schema_version', 'prompt_submissions', 'reload_checked'}):
                raise RuntimeError('Gateway qualification failed')
            output = ROOT / 'artifacts/native/ivy-activity-controls.json'
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report))
        finally:
            attached = await client.rpc('session.resume', session_id=sid)
            await client.rpc('session.detach', session_id=sid, subscription_id=attached['subscription_id'], end_reason='user_exit')


if __name__ == '__main__':
    asyncio.run(main())
