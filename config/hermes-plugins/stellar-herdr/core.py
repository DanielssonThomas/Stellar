"""Local Herdr Core and app CLI boundary for Ivy's Stellar workers."""
from __future__ import annotations

import json
import re
import subprocess
import time

LABEL = 'stellar-delegate=ivy'
ADDRESS = re.compile(r't[1-9][0-9]*')
WORKER_NAME = re.compile(r'stellar-([1-9][0-9]*)')
HIDDEN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
ROLES = ('peon-cloud', 'foreman-cloud')


class Unavailable(RuntimeError):
    pass


def command(argv, *, cwd=None, timeout=8):
    try:
        result = subprocess.run(
            [str(arg) for arg in argv], cwd=cwd, capture_output=True, check=False,
            encoding='utf-8', errors='replace', timeout=timeout, creationflags=HIDDEN,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Unavailable('The local command did not respond.') from None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise Unavailable('The local command did not return structured data.') from None
    if result.returncode or not isinstance(data, dict) or 'error' in data:
        raise Unavailable('The local command did not complete.')
    return data


class Core:
    def __init__(self, settings):
        self.hc = settings['core']
        self.app = settings['app']

    def call(self, *args, timeout=8):
        return command([self.hc, *args], timeout=timeout)

    def terminals(self, *, timeout=8):
        result = self.call('ls', '--all', '--label', LABEL, '--json', timeout=timeout)
        if not isinstance(result.get('terminals'), list):
            raise Unavailable('Herdr Core returned no worker inventory.')
        workers = []
        for row in result['terminals']:
            if not isinstance(row, dict):
                continue
            address = row.get('address', '')
            name = row.get('name')
            match = WORKER_NAME.fullmatch(name) if isinstance(name, str) else None
            if not match or not isinstance(address, str) or not ADDRESS.fullmatch(address):
                continue
            exit_code = row.get('exit_code')
            workers.append({
                'issue': int(match[1]), 'terminal': address,
                'state': row['state'] if row.get('state') in ('live', 'finished') else 'unknown',
                'exit_code': exit_code if type(exit_code) is int else None,
            })
        return sorted(workers, key=lambda row: int(row['terminal'][1:]), reverse=True)

    def detail(self, worker):
        row = self.call('get', worker['terminal'], '--json')
        labels = row.get('labels') or {}
        if (labels.get('stellar-delegate') != 'ivy' or
                labels.get('issue') != str(worker['issue']) or labels.get('role') not in ROLES):
            raise Unavailable('Herdr no longer identifies this terminal as an Ivy worker.')
        status = row.get('status')
        return {
            **worker, 'role': labels['role'],
            'status': status if status in ('working', 'idle', 'done', 'blocked', 'waiting') else None,
            'state': row['state'] if row.get('state') in ('live', 'finished') else 'unknown',
            'exit_code': row.get('exit_code'),
        }

    def progress(self, worker):
        detail = self.detail(worker)
        output = self.call('read', worker['terminal'], '--lines', '12', '--json')
        recent = output.get('text', '')
        return {**detail, 'untrusted_terminal_output': recent[-3500:] if isinstance(recent, str) else ''}

    def launch(self, issue, role, cwd, argv):
        result = self.call(
            'run', '--bg', '--no-parent', '--no-notify', '--json',
            '--name', f'stellar-{issue}', '--label', LABEL, '--label', f'issue={issue}',
            '--label', f'role={role}', '--cwd', cwd, '--', *argv,
        )
        if not ADDRESS.fullmatch(result.get('address', '')):
            raise Unavailable('Herdr did not confirm a worker terminal.')
        return result['address']

    def app_call(self, *args):
        return command([self.app, *args], timeout=3)

    def show(self):
        try:
            subprocess.Popen(
                [self.app], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=HIDDEN,
            )
        except OSError:
            raise Unavailable('The Herdr app could not open.') from None
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                self.app_call('status')
                return
            except Unavailable:
                time.sleep(0.25)
        raise Unavailable('The Herdr window did not report readiness.')

    def hide(self):
        try:
            self.app_call('status')
        except Unavailable:
            return 'unavailable'
        self.app_call('do', 'window.close')
        return 'close_requested'

    def focus(self, worker, *, open_window=True):
        detail = self.detail(worker)
        terminal = detail['terminal']
        if open_window:
            self.show()
        deadline = time.monotonic() + 4
        attached = False
        while time.monotonic() < deadline:
            for space in self.app_call('ls').get('spaces', []):
                for tab in space.get('tabs', []):
                    for pane in tab.get('terminals', []):
                        if pane.get('terminal') == terminal:
                            self.app_call('do', 'pane.focus', '--pane', pane['pane'])
                            return 'focused'
            if not attached:
                if detail['state'] != 'live':
                    raise Unavailable('This finished worker has no open pane. Its output is available through progress.')
                try:
                    self.app_call('do', 'terminal.keep', '--terminal', terminal, '--place', 'tab')
                    attached = True
                except Unavailable:
                    pass
            time.sleep(0.25)
        raise Unavailable('Herdr has not made the worker available as a tab.')
