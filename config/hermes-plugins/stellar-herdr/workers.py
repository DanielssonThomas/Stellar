"""Bind a Herdr launch to the personal Stellar issue claim."""
from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from .core import Core, ROLES, Unavailable, command

SESSION = re.compile(r'[a-zA-Z0-9._:-]{1,128}')
MODES = ('manual', 'automatic')


def load(profile):
    root = profile / 'integration' / 'stellar-herdr'
    try:
        data = json.loads((root / 'settings.json').read_text(encoding='utf-8'))
        keys = ('repo', 'core', 'app', 'hermes', 'node', 'gh', 'git')
        if type(data) is not dict or any(not Path(data[key]).is_absolute() for key in keys):
            raise ValueError
        return root, data
    except (OSError, ValueError, TypeError, KeyError):
        raise Unavailable('Stellar Herdr is unconfigured in this Ivy profile.') from None


def preference(root):
    try:
        mode = (root / 'view-mode.txt').read_text(encoding='utf-8').strip()
        return mode if mode in MODES else 'manual'
    except OSError:
        return 'manual'


def validate_claim(settings, issue, role, session):
    if (type(issue) is not int or not 1 <= issue <= 2**31 - 1 or role not in ROLES or
            type(session) is not str or not SESSION.fullmatch(session)):
        raise Unavailable('Supply an issue, a personal worker role and its exact claim session ID.')
    repo = Path(settings['repo']).resolve()
    record = command(
        [settings['node'], repo / 'tools/policy/manage-issue-worktree.mjs', 'inspect', issue], cwd=repo,
    )
    if (type(record) is not dict or record.get('issue') != issue or record.get('worker') != f'worker:{role}' or
            record.get('sessionId') != session or record.get('state') != 'active'):
        raise Unavailable('The active claim does not match this issue, worker and session.')
    try:
        deadline = datetime.fromisoformat(record['expiresAt'].replace('Z', '+00:00'))
        cwd = Path(record['worktreePath']).resolve(strict=True)
        branch = record['branch']
        target = record['target']
    except (OSError, KeyError, TypeError, ValueError, AttributeError):
        raise Unavailable('The claimed worktree is unavailable.') from None
    if (deadline.tzinfo is None or deadline <= datetime.now(timezone.utc) or cwd == repo or
            type(branch) is not str or not branch.startswith(f'issue/{issue}-') or type(target) is not str):
        raise Unavailable('This claim is expired or does not bind an issue worktree.')
    state = command(
        [settings['gh'], 'issue', 'view', issue, '--json', 'state,labels', '--jq',
         '{state,labels:[.labels[].name]}'], cwd=repo, timeout=12,
    )
    labels = set(state.get('labels', []))
    if (state.get('state') != 'OPEN' or
            {label for label in labels if label.startswith(('owner:', 'worker:', 'status:', 'target:'))}
            != {f'worker:{role}', 'status:in-progress', f'target:{target}'}):
        raise Unavailable('GitHub no longer shows the claimed worker, target and in-progress issue.')
    return cwd, branch, target


def git_text(settings, cwd, *args):
    from subprocess import run, TimeoutExpired
    from .core import HIDDEN
    try:
        result = run([settings['git'], 'rev-parse', *args], cwd=cwd, capture_output=True,
                     encoding='utf-8', errors='replace', timeout=4, creationflags=HIDDEN)
    except (OSError, TimeoutExpired):
        raise Unavailable('Git could not verify the issue worktree.') from None
    if result.returncode:
        raise Unavailable('Git could not verify the issue worktree.')
    return result.stdout.strip()


def submit(root, settings, core, issue, role, session, task):
    if type(task) is not str or not 1 <= len(task.strip()) <= 16000 or '\0' in task:
        raise Unavailable('Supply a bounded task with allowed paths and verification.')
    cwd, branch, target = validate_claim(settings, issue, role, session)
    if git_text(settings, cwd, '--abbrev-ref', 'HEAD') != branch:
        raise Unavailable('The checked-out branch differs from the active claim.')
    head = git_text(settings, cwd, 'HEAD')
    try:
        workers = core.terminals()
    except Unavailable:
        core.call('server', 'start')
        workers = core.terminals()
    if any(row['issue'] == issue and row['state'] != 'finished' for row in workers):
        raise Unavailable('This issue already has a live or unresolved Herdr terminal. Read its status.')
    fingerprint = hashlib.sha256(session.encode('utf-8')).hexdigest()
    attempts = root / 'attempts'
    attempts.mkdir(parents=True, exist_ok=True)
    attempt = attempts / f'{issue}-{fingerprint}'
    try:
        attempt.mkdir()
    except FileExistsError:
        raise Unavailable('This claim already has a launch receipt. Check its terminal and worktree before reassignment.') from None
    task_file = attempt / 'task.md'
    task_file.write_text(
        f'# Stellar issue {issue}\n\nWorker: {role}\nClaim session: {session}\n'
        f'Worktree: {cwd}\nBranch: {branch}\nTarget: {target}\nBaseline: {head}\n\n'
        'Read AGENTS.md and the personal Ivy coding workflow. Keep to the assigned paths and issue. '
        'Do not edit protected governance, access credentials, merge, deploy or bypass approvals.\n\n'
        + task,
        encoding='utf-8',
    )
    try:
        terminal = core.launch(issue, role, cwd, [
            settings['hermes'], '-p', role, 'chat', '--in', cwd, '--query-file', task_file,
            '--oneshot', '--max-turns', '24', '--format', 'stream-json',
        ])
    except Unavailable:
        raise Unavailable('Herdr did not confirm the launch. The receipt was retained. Inspect Core and the worktree before reassigning.') from None
    row = {'issue': issue, 'terminal': terminal, 'role': role, 'launch': 'accepted'}
    (attempt / 'terminal.json').write_text(json.dumps(row), encoding='utf-8')
    if preference(root) == 'automatic':
        try:
            row['view'] = core.focus({**row, 'state': 'live'})
        except Unavailable:
            row['view'] = 'unavailable'
    return row


def find_worker(core, issue):
    if type(issue) is not int or issue < 1:
        raise Unavailable('Specify a Stellar issue number.')
    for worker in core.terminals():
        if worker['issue'] == issue:
            return worker
    raise Unavailable('Core has no retained Ivy worker for that issue.')


def operate(profile, args):
    root, settings = load(profile)
    core = Core(settings)
    action = args.get('action')
    issue = args.get('issue')
    if action == 'status':
        return {'view_preference': preference(root), 'workers': core.terminals()[:20]}
    if action == 'progress':
        return core.progress(find_worker(core, issue))
    if action == 'launch':
        return submit(root, settings, core, issue, args.get('role'), args.get('session_id'), args.get('task'))
    if action == 'show':
        core.show()
        view = {'view': 'open'}
        try:
            live = next((row for row in core.terminals() if row['state'] == 'live'), None)
            if live is not None:
                view['worker_view'] = core.focus(live, open_window=False)
                view['issue'] = live['issue']
        except Unavailable:
            view['worker_view'] = 'unavailable'
        return view
    if action == 'hide':
        return {'view': core.hide()}
    if action == 'focus':
        return {'view': core.focus(find_worker(core, issue)), 'issue': issue}
    if action == 'preference' and args.get('mode') in MODES:
        mode = args['mode']
        temporary = root / f'view-{time.time_ns()}.tmp'
        temporary.write_text(mode, encoding='utf-8')
        temporary.replace(root / 'view-mode.txt')
        return {'view_preference': mode}
    raise Unavailable('Choose status, progress, launch, show, hide, focus or preference.')


def observe(profile):
    try:
        _, settings = load(profile)
    except Unavailable:
        return None
    try:
        workers = Core(settings).terminals(timeout=1.0)
    except Unavailable:
        return {'context': 'Herdr Core worker inventory is unavailable this turn.'}
    live = [row for row in workers if row['state'] != 'finished']
    recent = [row for row in workers if row['state'] == 'finished'][:4]
    snapshot = {'active_count': len(live), 'workers': (live + recent)[:20]}
    return {'context': 'Current Ivy Stellar worker metadata from Herdr Core. '
            'Use stellar_herdr for governed Stellar worker launches and Herdr views when available. '
            'A live terminal confirms a process, and exit zero confirms only process exit. '
            'Use stellar_herdr progress for details and verify actual work before reporting success.\n'
            + json.dumps(snapshot, separators=(',', ':'))}
