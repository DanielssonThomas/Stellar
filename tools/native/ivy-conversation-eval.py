"""Opt-in live Ivy regression. Uses disposable hidden sessions and no microphone capture."""
from __future__ import annotations

import argparse
import array
import asyncio
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
import uuid
import wave
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
NATIVE = Path('apps/stellar-desktop/src-tauri/src')
CASES = Path(__file__).with_name('ivy-conversation-cases.json')
RECOGNITION_PYTHON = Path('D:/Hermes/profiles/ivy/recognition/.venv/Scripts/python.exe')
NOTEBOOK_OPT_OUT = 'Off the record for Ivy Notebook.\n\n'
SOURCE_MODULES = {
    'stellar_ivy_activity': 'ivy_activity.py',
    'stellar_ivy_controls': 'ivy_controls.py',
    'stellar_ivy_edit_policy': 'ivy_edit_policy.py',
    'stellar_workspace_protocol': 'workspace_protocol.py',
    'stellar_workspace_mcp': 'workspace_mcp.py',
    'stellar_workspace_service': 'workspace_service.py',
}
REPO = 'DanielssonThomas/Stellar'


def module(source, name):
    spec = importlib.util.spec_from_file_location(name, source)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


@contextlib.contextmanager
def source_tree(ref):
    with tempfile.TemporaryDirectory(prefix='stellar-ivy-evaluation-') as folder:
        target = Path(folder) / NATIVE
        if ref is None:
            for area in ('ivy', 'speech'):
                (target / area).mkdir(parents=True)
                for path in (ROOT / NATIVE / area).glob('*.py'):
                    shutil.copyfile(path, target / area / path.name)
        else:
            commit = git('rev-parse', '--verify', ref + '^{commit}')
            path = NATIVE.as_posix()
            archive = subprocess.check_output(['git', 'archive', '--format=zip', commit, '--', path], cwd=ROOT)
            with zipfile.ZipFile(io.BytesIO(archive)) as tracked:
                # Extract only individual Python files from this checkout.
                for name in tracked.namelist():
                    if re.fullmatch(re.escape(path) + r'/(ivy|speech)/[a-z_]+\.py', name):
                        tracked.extract(name, folder)
        yield target


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def json_command(args, timeout):
    return json.loads(subprocess.check_output(args, cwd=ROOT, encoding='utf-8',
                                              timeout=timeout, stderr=subprocess.DEVNULL))


def pull_states():
    fields = 'number,state,isDraft,baseRefName,url'
    return [json_command(['gh', 'pr', 'view', str(n), '--repo', REPO, '--json', fields], 15)
            for n in (335, 336)]


def displays():
    powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    # Fixed, read-only query. Do not execute any model-provided command or capture pixels.
    command = ('Add-Type -AssemblyName System.Windows.Forms; '
               '@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '
               '@{width=$_.Bounds.Width; height=$_.Bounds.Height; primary=$_.Primary} }) '
               '| ConvertTo-Json -Compress')
    found = json_command([str(powershell), '-NoProfile', '-NonInteractive', '-Command', command], 8)
    if type(found) is dict:
        found = [found]
    return [{'id': str(index), 'name': f'Display {index}', 'foreground': False, **screen}
            for index, screen in enumerate(found, 1)]


class MemoryCredentials:
    def create(self):
        return secrets.token_hex(16), secrets.token_urlsafe(32)


class DisplayOperation:
    """Only the explicit display scenario can perform the real read-only host operation."""

    def __init__(self, protocol, service, mcp, enabled):
        self.enabled = enabled
        self.calls = []
        self.display_details = None
        gate = protocol.WorkspaceGate(self.handle)
        self.workspace = service.WorkspaceService(MemoryCredentials(), gate, mcp.make_server)

    def handle(self, frame):
        request = frame['data']
        kind = request['operation']['kind']
        self.calls.append(kind)
        if kind in {'capture_window', 'capture_display', 'capture_foreground'}:
            self.workspace.gate.reject_image({key: request[key]
                for key in ('version', 'request_id', 'epoch', 'turn_id')}, 'capture_unavailable')
            return
        outcome = {'kind': 'rejected'}
        if kind == 'list_displays' and self.enabled:
            self.display_details = displays()
            outcome = {'kind': 'displays', 'displays': self.display_details}
        self.workspace.gate.reply({**{key: request[key]
            for key in ('version', 'request_id', 'epoch', 'turn_id')}, 'outcome': outcome})


def replay_recording(recordings, case, expected, worker):
    if recordings is None:
        return None
    manifest = json.loads((recordings / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('fixtureKind') != 'recorded-human' or not any(
            item.get('id') == case and item.get('text') == expected for item in manifest['trials']):
        raise ValueError('Fixture must be a known matching human recording')
    path = recordings / (case + '.wav')
    with wave.open(str(path), 'rb') as clip:
        if ((clip.getnchannels(), clip.getsampwidth(), clip.getframerate()) != (1, 2, 16000)
                or not 1 <= clip.getnframes() <= 320000):
            raise ValueError('Expected a mono PCM16 WAV at 16 kHz, up to 20 seconds')
        pcm = array.array('h', clip.readframes(clip.getnframes()))
        if sys.byteorder != 'little':
            pcm.byteswap()
    call = json.dumps({'pcm': list(pcm), 'sample_rate_hz': 16000}).encode() + b'\n'
    run = subprocess.run([str(RECOGNITION_PYTHON), '-I', str(worker), 'transcribe'],
                         input=call, check=True, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, timeout=45)
    transcript = json.loads(run.stdout)['text']
    if transcript.strip().casefold() != expected.casefold():
        # A different or private transcript must not be forwarded to the provider.
        raise ValueError('Parakeet did not reproduce the consented spoken fixture text')
    return {'transcript': transcript, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'duration_ms': round(len(pcm) / 16)}


def identity():
    return uuid.uuid4().hex


async def rpc(bridge, conn, workspace, method, **params):
    request = bridge.validate({'id': 1, 'method': method, 'params': params})
    queue = asyncio.Queue()
    await queue.put(request)
    await queue.put(None)
    frames = []
    # No background bridge event consumer. The receipt poll settles the same writer lease.
    with patch.object(bridge, 'emit', frames.append):
        await bridge.request_worker(conn, workspace, queue)
    if len(frames) != 1 or 'result' not in frames[0]:
        raise RuntimeError('The Desktop bridge did not confirm ' + method)
    return frames[0]['result']


def tool_names(messages, start):
    tools = set()
    for message in messages[start:]:
        if type(message) is not dict:
            continue
        for call in message.get('tool_calls') or []:
            if type(call) is dict and type(call.get('function')) is dict:
                function = call['function']
                name = function.get('name')
                if type(name) is str:
                    tools.add(name)
                if name == 'tool_call':
                    args = function.get('arguments')
                    if type(args) is str:
                        with contextlib.suppress(ValueError):
                            args = json.loads(args)
                    if type(args) is dict:
                        entries = args.get('calls', [args])
                        if type(entries) is list:
                            tools.update(entry['name'] for entry in entries if type(entry) is dict
                                         and type(entry.get('name')) is str)
        if message.get('role') == 'tool' and type(message.get('name')) is str:
            tools.add(message['name'])
    return sorted(tools)


def prompt_attestation(info):
    prompt = info.get('system_prompt')
    if type(prompt) is not str:
        return {'available': False}
    return {'available': True, 'length': len(prompt),
            'ivy_conversational_instinct': '## Conversational instinct' in prompt,
            'hermes_finishing_the_job': '# Finishing the job' in prompt,
            'hermes_execution_discipline': '# Execution discipline' in prompt}


async def turn(bridge, conn, workspace, sid, text, timeout):
    before = await conn.client.rpc('session.resume', session_id=sid)
    started = time.monotonic()
    submitted = await rpc(bridge, conn, workspace, 'prompt.submit', session_id=sid,
                          input_id=str(uuid.uuid4()), text=NOTEBOOK_OPT_OUT + text, workspace_epoch='1')
    admission = submitted['admission_id']
    while time.monotonic() - started < timeout:
        receipt = await rpc(bridge, conn, workspace, 'prompt.receipt',
                            session_id=sid, admission_id=admission, include_result=True)
        if receipt.get('status') == 'terminal':
            break
        await asyncio.sleep(.4)
    else:
        raise TimeoutError('Real model admission did not settle; no resend')
    elapsed = round((time.monotonic() - started) * 1000)
    after = await conn.client.rpc('session.resume', session_id=sid)
    messages = after.get('messages', [])
    latest_user = next((row.get('content') for row in reversed(messages) if row.get('role') == 'user'), None)
    return {'outcome': receipt.get('outcome'), 'response': receipt.get('result', {}).get('final_response', ''),
            'elapsed_ms': elapsed, 'tool_names': tool_names(messages, len(before.get('messages', []))),
            'history_clean': latest_user == NOTEBOOK_OPT_OUT + text,
            'model': after.get('info', {}).get('model')}


async def cleanup(conn, sid, row):
    snapshot = await conn.client.rpc('session.resume', session_id=sid)
    if snapshot.get('running') or snapshot.get('pending'):
        row['fixture_session_cleanup'] = 'pending'
        return
    result = await conn.client.rpc('session.mutate', session_id=sid, request_id=identity(),
        expected_revision=snapshot['revision'], expected_generation=snapshot['execution_generation'],
        operation='delete', payload={})
    row['fixture_session_cleanup'] = 'deleted' if sid in result.get('deleted_ids', []) else 'unconfirmed'


async def evaluate(case, client, connection, bridge, modules, args, recording):
    protocol, service, mcp = (modules['stellar_workspace_' + name] for name in ('protocol', 'service', 'mcp'))
    operation = DisplayOperation(protocol, service, mcp, case.get('tool') == 'list_displays')
    row = {'id': case['id'], 'intent': case['intent'], 'review': case['review'], 'turns': []}
    if case.get('tool') == 'github-read':
        row['expected_github'] = await asyncio.to_thread(pull_states)
    workspace = operation.workspace
    await workspace.start()
    conn = connection(workspace.wrap_client(client), approvals=False)
    conversation = modules.get('stellar_ivy_conversation')
    if conversation is not None:
        from hermes_cli.gateway_client import GatewayRPCError
        conn.client = conversation.ConversationClient(conn.client, GatewayRPCError)
    sid = None
    try:
        created = await client.rpc('session.create', source='acp', cwd='D:/', hidden=True,
            title='Stellar conversation qualification ' + identity()[:10], request_id=identity(),
            model=args.model, provider='openai-codex', toolsets=['terminal', 'web'] if 'expected_github' in row else [],
            editor=workspace.editor())
        sid = created['session_id']
        workspace.bind_session(sid)
        await rpc(bridge, conn, workspace, 'session.resume', session_id=sid)
        for index, text in enumerate(case['turns']):
            spoken = recording is not None and index == len(case['turns']) - 1 and 'audio' in case
            if spoken:
                text = recording['transcript']
            result = await turn(bridge, conn, workspace, sid, text, args.timeout)
            row['turns'].append({'input': text, 'source': 'recorded_speech_replay' if spoken else 'typed_text',
                                 **result})
            if result['outcome'] != 'completed' or not result['response']:
                break
        if 'audio' in case:
            row['spoken_evidence'] = (recording if recording is not None else
                {'status': 'skipped_no_recording_directory; last turn used typed fallback'})
        info = await client.rpc('session.info', session_id=sid)
        row['system_prompt'] = prompt_attestation(info)
        if conversation is not None:
            row['model_only_context_supported'] = conn.client.supports_api_text
    finally:
        try:
            if sid is not None:
                await cleanup(conn, sid, row)
        finally:
            conn.lease.release()
            await workspace.stop()
    row['workspace_operations'] = operation.calls
    if operation.display_details is not None:
        row['observed_display_resolutions'] = [[item['width'], item['height']]
                                               for item in operation.display_details]
    return row


async def run(args, source, cases):
    ivy = source / 'ivy'
    bridge = module(ivy / 'ivy_bridge.py', 'evaluation_ivy_bridge')
    connection, discover, connect = bridge.load_library()
    modules = {name: module(ivy / file, name) for name, file in SOURCE_MODULES.items()}
    if (ivy / 'ivy_conversation.py').is_file():
        name = 'stellar_ivy_conversation'
        modules[name] = module(ivy / 'ivy_conversation.py', name)
    found = await asyncio.to_thread(discover, bridge.PROFILE, timeout=2)
    if found.state != 'ready' or found.endpoint is None:
        raise RuntimeError('Existing Ivy gateway unavailable; evaluation does not launch it')
    rows = []
    async with connect(found.endpoint) as client:
        for case in cases:
            recording = replay_recording(args.recordings, case['audio'], case['turns'][-1],
                source / 'speech/recognition_worker.py') if 'audio' in case else None
            row = await evaluate(case, client, connection, bridge, modules, args, recording)
            row['protocol_checks_passed'] = protocol_checks(case, row)
            rows.append(row)
            save_report(args, source, rows)
            print(f"{case['id']}: " + ', '.join(str(turn['outcome']) for turn in row['turns']), flush=True)
    return rows


def save_report(args, source, rows):
    report = {'schema_version': 1, 'model': args.model, 'source_revision': args.commit,
              'source_sha256': {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                                for name in ('ivy/ivy_bridge.py', 'ivy/workspace_mcp.py',
                                             'speech/recognition_worker.py')},
              'cases_sha256': hashlib.sha256(CASES.read_bytes()).hexdigest(),
              'notebook_opt_out': NOTEBOOK_OPT_OUT.strip(),
              'scope': 'Live Hermes Desktop bridge and actual model; no WebView or live microphone.',
              'cases': rows}
    policy = source / 'ivy/ivy_conversation.py'
    if policy.is_file():
        report['conversation_policy_sha256'] = hashlib.sha256(policy.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def protocol_checks(case, row):
    """Mechanically check execution and history, leaving reply quality to the scenario rubric."""
    if row['fixture_session_cleanup'] != 'deleted' or len(row['turns']) != len(case['turns']):
        return False
    if any(turn['outcome'] != 'completed' or not turn['response'] for turn in row['turns']):
        return False
    if row.get('model_only_context_supported') and any(not turn['history_clean'] for turn in row['turns']):
        return False
    if case.get('tool') == 'list_displays':
        return (row['workspace_operations'] == ['list_displays']
                and bool(row.get('observed_display_resolutions')))
    if row['workspace_operations']:
        return False
    if case.get('tool') == 'github-read':
        return any(set(turn['tool_names']) & {'terminal', 'web_search', 'web_extract'} for turn in row['turns'])
    return all(not turn['tool_names'] for turn in row['turns'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-live', action='store_true', required=True)
    parser.add_argument('--source-ref', help='Optional tracked baseline commit for the bridge and workers')
    parser.add_argument('--model', choices=('gpt-6.1-terra', 'gpt-6.1-sol'), default='gpt-6.1-terra')
    parser.add_argument('--case', action='append', help='Run a subset of the named cases')
    parser.add_argument('--recordings', type=Path, help='Existing human calibration directory')
    parser.add_argument('--timeout', type=int, default=90)
    parser.add_argument('--output', type=Path, required=True, help='Local report with prompts and replies')
    args = parser.parse_args()
    cases = json.loads(CASES.read_text(encoding='utf-8'))
    unknown = set(args.case or ()) - {case['id'] for case in cases}
    if unknown or not 10 <= args.timeout <= 180:
        parser.error('Unknown case or timeout outside 10..180 seconds')
    cases = [case for case in cases if not args.case or case['id'] in args.case]
    args.commit = git('rev-parse', '--verify', (args.source_ref or 'HEAD') + '^{commit}')
    with source_tree(args.source_ref) as source:
        rows = asyncio.run(run(args, source, cases))
    failed = [row['id'] for row in rows if not row['protocol_checks_passed']]
    if failed:
        print('Execution, tool scope or history check failed for ' + ', '.join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
