"""Personal-host consent stays outside renderer and model-controlled messages."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path


def load_access(profile):
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate access setting')
            result[key] = value
        return result

    try:
        path = Path(profile) / 'integration' / 'desktop-access.json'
        if path.stat().st_size > 1024:
            return {}
        value = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique)
        if (type(value) is dict and set(value) == {'version', 'file_edits', 'interactive'}
                and type(value['version']) is int and value['version'] == 1
                and value['file_edits'] in ('ask', 'all') and type(value['interactive']) is bool):
            return value
    except (OSError, ValueError):
        pass
    return {}


def file_proposal(payload):
    edit = payload.get('edit')
    return (type(edit) is dict and edit.get('tool_name') in {'write_file', 'patch'}
            and type(edit.get('path')) is str and bool(edit['path'])
            and type(edit.get('new_text')) is str
            and (edit.get('old_text') is None or type(edit['old_text']) is str)
            and type(edit.get('arguments')) is dict)


# Fixed code; request content is data on stdin and never PowerShell source.
DIALOG = r'''
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$owner = [Diagnostics.Process]::GetProcessById([int]$request.owner_pid)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Stellar - Ivy approval'
$form.Size = New-Object Drawing.Size(760, 520)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$text = New-Object System.Windows.Forms.TextBox
$text.Multiline = $true
$text.ReadOnly = $true
$text.ScrollBars = 'Both'
$text.WordWrap = $true
$text.Dock = 'Fill'
$text.Text = $request.text
$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.Dock = 'Bottom'
$buttons.Height = 48
$buttons.FlowDirection = 'RightToLeft'
$deny = New-Object System.Windows.Forms.Button
$deny.Text = 'Deny'
$deny.DialogResult = 'Cancel'
$allow = New-Object System.Windows.Forms.Button
$allow.Text = 'Allow once'
$allow.Width = 110
$allow.DialogResult = 'OK'
$buttons.Controls.Add($deny)
$buttons.Controls.Add($allow)
$form.Controls.Add($text)
$form.Controls.Add($buttons)
$form.AcceptButton = $deny
$form.CancelButton = $deny
$elapsed = [Diagnostics.Stopwatch]::StartNew()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
    if ($owner.HasExited -or $elapsed.Elapsed.TotalSeconds -ge 90) {
        $form.DialogResult = 'Cancel'
        $form.Close()
    }
})
$timer.Start()
try {
    if ($form.ShowDialog() -eq 'OK') { [Console]::Write('once') }
    else { [Console]::Write('deny') }
} finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    $owner.Dispose()
}
'''


async def native_consent(payload):
    if os.name != 'nt':
        return 'deny'
    edit = payload.get('edit')
    text = '\n\n'.join(str(payload.get(key) or '') for key in ('description', 'command'))
    if type(edit) is dict:
        text += '\n\nProposed edit:\n' + json.dumps({
            key: edit.get(key) for key in ('path', 'old_text', 'new_text')}, ensure_ascii=False)
    # Oversized requests are refused rather than approving a truncated command or diff.
    if not text.strip() or len(text) > 24000:
        return 'deny'
    system = Path(os.environ.get('SystemRoot', 'C:/Windows'))
    executable = system / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    process = await asyncio.create_subprocess_exec(
        str(executable), '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
        base64.b64encode(DIALOG.encode('utf-16-le')).decode('ascii'),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, creationflags=0x08000000)
    try:
        output, _ = await asyncio.wait_for(process.communicate(
            json.dumps({'text': text, 'owner_pid': os.getpid()}, ensure_ascii=False).encode('utf-8')), 90)
        return 'once' if process.returncode == 0 and output == b'once' else 'deny'
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()


class Approvals:
    def __init__(self, client, selected, access, consent=native_consent):
        self.client, self.selected, self.access, self.consent = client, selected, access, consent
        self.tasks = {}
        self.seen = set()
        self.resuming = None

    def begin_resume(self, sid):
        self.resuming = (sid, asyncio.get_running_loop().create_future())

    def finish_resume(self, ready):
        if self.resuming is not None:
            _, pending = self.resuming
            self.resuming = None
            pending.set_result(ready)

    def offer(self, params):
        payload = params.get('payload', {})
        sid = params.get('session_id')
        generation = payload.get('execution_generation', params.get('execution_generation'))
        prompt = payload.get('prompt_id')
        if (type(sid) is not str or not sid or type(prompt) is not str or not prompt
                or type(generation) is not int or generation < 0):
            raise ValueError('Malformed approval fence')
        key = (sid, generation, prompt)
        if key in self.seen:
            return
        self.tasks = {key: task for key, task in self.tasks.items() if not task.done()}
        if len(self.tasks) >= 4:
            raise ValueError('Too many pending approvals')
        if len(self.seen) >= 1024:
            raise ValueError('Too many approval identities')
        self.seen.add(key)
        self.tasks[key] = asyncio.create_task(self.respond(key, payload))

    async def respond(self, key, payload):
        sid, generation, prompt = key
        choice = 'deny'
        try:
            ready = True
            if self.resuming is not None and sid == self.resuming[0]:
                ready = await asyncio.shield(self.resuming[1])
            if ready and sid == self.selected():
                if self.access.get('file_edits') == 'all' and file_proposal(payload):
                    choice = 'once'
                elif self.access.get('interactive') is True:
                    try:
                        choice = await self.consent(payload)
                    except Exception:
                        choice = 'deny'
            if sid != self.selected() or choice not in ('once', 'deny'):
                choice = 'deny'
            # The gateway checks this exact observed generation and one-use prompt.
            await asyncio.wait_for(self.client.rpc('approval.respond', session_id=sid,
                execution_generation=generation, prompt_id=prompt, choice=choice), 15)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A withdrawn/stale prompt is never retried against a new execution.
            pass

    async def cancel(self, sid=None):
        selected = [key for key in self.tasks if sid is None or key[0] == sid]
        for key in selected:
            self.tasks[key].cancel()
        await asyncio.gather(*(self.tasks[key] for key in selected), return_exceptions=True)
        for key in selected:
            del self.tasks[key]
        self.seen = {key for key in self.seen if sid is not None and key[0] != sid}

    async def settle(self, params):
        payload = params.get('payload', {})
        key = (params.get('session_id'), payload.get('execution_generation',
               params.get('execution_generation')), payload.get('prompt_id'))
        task = self.tasks.pop(key, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
