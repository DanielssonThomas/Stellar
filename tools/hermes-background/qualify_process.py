"""Offline qualification of the actual installed public process path; never contacts Ivy."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
from types import SimpleNamespace


def qualify(runtime: Path):
    with tempfile.TemporaryDirectory(prefix='stellar339-process-') as folder:
        home = Path(folder)
        allowed = {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'LANG', 'TZ'}
        clean = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        os.environ.clear()
        os.environ.update(clean)
        os.environ['HERMES_HOME'] = str(home / 'home')
        os.environ['HOME'] = str(home / 'user')
        os.environ['USERPROFILE'] = str(home / 'user')
        os.environ['LOCALAPPDATA'] = str(home / 'local')
        os.environ['APPDATA'] = str(home / 'roaming')
        os.environ['TERMINAL_ENV'] = 'local'
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'config/hermes-compat/stellar-background-v1'))
        from stellar_background.provenance import verify_runtime
        verify_runtime(runtime)
        sys.path.insert(0, str(runtime))
        def no_external_network(event, args):
            if event == 'socket.connect' and isinstance(args[1], tuple) and str(args[1][0]) not in ('127.0.0.1', '::1', 'localhost'):
                raise RuntimeError('External network disabled for isolated qualification')
        sys.addaudithook(no_external_network)
        from hermes_cli.plugins import PluginContext
        from gateway.session_context import clear_session_vars, set_session_vars
        from tools import terminal_tool  # registers the actual public handler
        from tools.process_registry import process_registry

        ctx = object.__new__(PluginContext)
        ctx._manager = SimpleNamespace(_cli_ref=None, scope_key=None)
        fixture = home / 'process_fixture.py'
        fixture.write_text("print('stellar339-process-fixture')\n", encoding='utf-8')
        observations = []
        for allowed in (True, False):
            tokens = set_session_vars(platform='local', source='acp', chat_id='fixture-original',
                session_key='fixture-route', session_id='fixture-physical', profile='fixture-ivy',
                cwd=str(home), async_delivery=allowed)
            try:
                command = shlex.join([Path(sys.executable).as_posix(), '-I', '-B', fixture.as_posix()])
                raw = ctx.dispatch_tool('terminal', {'command': command, 'background': True,
                    'notify_on_complete': True, 'workdir': str(home)}, task_id='fixture-task')
                result = json.loads(raw)
                if result.get('error') or not result.get('session_id'):
                    raise RuntimeError(f"Public terminal qualification failed: {result.get('error', 'no process')}")
                proc = process_registry.get(result['session_id'])
                observation = {'declaredAsyncDelivery': allowed,
                    'notifyEnabled': result.get('notify_on_complete') is True,
                    'unsupportedReported': 'notify_unsupported' in result,
                    'originalPhysicalSession': proc.parent_session_id == 'fixture-physical',
                    'originalRoute': proc.session_key == 'fixture-route',
                    'realTrackedChild': bool(proc.pid)}
                if (observation['notifyEnabled'] != allowed or observation['unsupportedReported'] == allowed
                        or not observation['realTrackedChild'] or not observation['originalRoute']
                        or (allowed and not observation['originalPhysicalSession'])):
                    raise RuntimeError('Public terminal context/notification qualification did not pass')
                observations.append(observation)
                waited = json.loads(ctx.dispatch_tool('process_manage', {'action': 'wait',
                    'session_id': result['session_id'], 'timeout': 10}, task_id='fixture-task'))
                if waited.get('exit_code') != 0 or 'stellar339-process-fixture' not in waited.get('output', waited.get('new_output', '')):
                    raise RuntimeError(f'Real tracked fixture child failed: {waited}')
            finally:
                clear_session_vars(tokens)
        return {'schemaVersion': 1, 'syntheticContext': True, 'realProcesses': True,
            'liveIvyOrModelUsed': False, 'observations': observations,
            'qualified': ['public plugin-to-terminal dispatch', 'actual tracked child',
                          'spawning physical-session stamp when async delivery is supported',
                          'explicit unsupported asynchronous-delivery result'],
            'notQualified': ['named-Ivy ACP live admission', 'atomic opt-out',
                'public process-to-admission receipt lookup', 'physical-target refusal on compression',
                'visible conversation answer', 'speech'],
            'runtimeFiles': {name: hashlib.sha256((runtime / name).read_bytes()).hexdigest()
                for name in ('hermes_cli/plugins_context.py', 'tools/terminal_tool_background.py')}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = qualify(args.runtime.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
