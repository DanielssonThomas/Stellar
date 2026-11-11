"""Opt-in real ACP creation/inventory probe; no prompt, elevated process or desktop input."""
import asyncio
import importlib.util
import json
from pathlib import Path
import secrets
import sys
import uuid
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'apps/stellar-desktop/src-tauri/src/ivy'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SOURCE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules[name] = module
    return module


async def main():
    bridge = load('bridge', 'ivy_bridge.py')
    connection, discover, connect = bridge.load_library()
    profile = load('stellar_ivy_profile_tools', 'ivy_profile_tools.py')
    load('stellar_ivy_controls', 'ivy_controls.py')
    load('stellar_ivy_edit_policy', 'ivy_edit_policy.py')
    load('stellar_ivy_conversation', 'ivy_conversation.py')
    protocol = load('stellar_workspace_protocol', 'workspace_protocol.py')
    mcp = load('stellar_workspace_mcp', 'workspace_mcp.py')
    service = load('stellar_workspace_service', 'workspace_service.py')

    class MemoryCredentials:
        def create(self):
            return secrets.token_hex(16), secrets.token_urlsafe(32)

    workspace = service.WorkspaceService(MemoryCredentials(), protocol.WorkspaceGate(lambda _: None), mcp.make_server)
    found = await asyncio.to_thread(discover, bridge.PROFILE, timeout=2)
    if found.state != 'ready' or found.endpoint is None:
        raise RuntimeError('Existing Ivy gateway unavailable; no gateway will be launched')
    expected = profile.load_toolsets()
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools
    restricted = load_config()
    restricted.setdefault('agent', {})['disabled_toolsets'] = ['computer_use']
    disabled_respected = 'computer_use' not in profile.select_toolsets(restricted, _get_platform_tools)
    restricted.setdefault('platform_toolsets', {})['desktop'] = []
    empty_respected = not {'computer_use', 'terminal', 'file'} & set(profile.select_toolsets(restricted, _get_platform_tools))
    async with connect(found.endpoint) as client:
        before = await client.rpc('runtime.describe')
        await workspace.start()
        conn = connection(workspace.wrap_client(client), approvals=False)
        frames = []
        try:
            queue = asyncio.Queue()
            await queue.put((1, 'session.create', {'request_id': 'stellar-profile-tools-' + uuid.uuid4().hex,
                                                 'model': 'gpt-6.1-terra'}))
            await queue.put(None)
            with patch.object(bridge, 'emit', frames.append):
                await bridge.request_worker(conn, workspace, queue)
            sid = frames[-1]['result']['session_id']
            attached = await client.rpc('session.resume', session_id=sid)
            info = attached['info']
            tools = {name for names in info.get('tools', {}).values() for name in names}
            # Inventory's API schemas collapse deferred tools into tool_search. Inspect its
            # raw scoped catalog as well; absence from the visible schemas is not denial.
            from model_tools import get_tool_definitions
            from toolsets import session_disabled_toolsets
            config = load_config()
            disabled = session_disabled_toolsets((config.get('agent') or {}).get('disabled_toolsets'), 'acp')
            catalog = get_tool_definitions(enabled_toolsets=info['enabled_toolsets'], disabled_toolsets=disabled,
                                          quiet_mode=True, skip_tool_search_assembly=True)
            scoped = {item['function']['name'] for item in catalog}
            from tools.computer_use.permissions import computer_use_status
            status = await asyncio.to_thread(computer_use_status)
            report = {
                'prompt_submissions': 0,
                'source': info.get('source'),
                'profile_toolsets': expected,
                'launch_selection_verified': info['launch_request']['toolsets'] == expected,
                'computer_use_available': 'computer_use' in scoped,
                'file_tools_available': {'read_file', 'write_file', 'patch'} <= tools,
                'terminal_available': 'terminal' in tools,
                'workspace_verified': workspace.verifies(info),
                'no_bypass': not any(info['launch_request'].get(key) for key in ('yolo', 'ignore_user_config', 'safe_mode')),
                'computer_use_driver_ready': status.get('ready') is True,
                'global_disable_respected': disabled_respected,
                'empty_native_selection_respected': empty_respected,
                'same_gateway': (await client.rpc('runtime.describe'))['instance_id'] == before['instance_id'],
            }
            await client.rpc('session.detach', session_id=sid, subscription_id=attached['subscription_id'], end_reason='user_exit')
            output = ROOT / 'artifacts/native/ivy-profile-tools.json'
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report))
            if report['source'] != 'acp' or not all(value for value in report.values() if type(value) is bool):
                raise RuntimeError('Real profile-tool qualification failed')
        finally:
            await workspace.stop()


if __name__ == '__main__':
    asyncio.run(main())
