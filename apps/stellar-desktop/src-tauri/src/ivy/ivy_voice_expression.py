"""One-use handoff to the optional middleware in the same Hermes profile."""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import stat
import time

TTL = 30
READINESS_TIMEOUT = 0.05
MAX_PENDING = 4
OWNED_NAME = re.compile(r'[0-9a-f]{32}\.(?:json|claimed|tmp)', re.ASCII)
LABELS = {'angry', 'disgusted', 'fearful', 'happy', 'neutral', 'sad', 'surprised'}


def native_codex_transport():
    from hermes_cli.config import load_config

    config = load_config()
    model = config.get('model')
    return (isinstance(model, dict) and model.get('provider') == 'openai-codex' and
            str(model.get('openai_runtime', '')).strip().lower() != 'codex_app_server')


def installed(profile):
    return (profile / 'plugins' / 'stellar-voice-expression' / 'plugin.yaml').is_file()


async def ready(client):
    async def inspect():
        if not await asyncio.to_thread(native_codex_transport):
            return False
        result = await client.rpc('plugins.list')
        rows = result.get('plugins') if type(result) is dict else None
        return type(rows) is list and any(
            type(row) is dict and row.get('key') == 'stellar-voice-expression' and
            row.get('enabled') is True and row.get('error') == '' and row.get('version') == '1.0.0'
            for row in rows
        )

    try:
        return await asyncio.wait_for(inspect(), READINESS_TIMEOUT)
    except Exception:
        # Capability discovery can never hold up or refuse an ordinary voice turn.
        return False


def valid(expression):
    if type(expression) is not dict or set(expression) not in (
        {'primary', 'confidence'}, {'primary', 'secondary', 'confidence'},
    ):
        return False
    primary, confidence = expression['primary'], expression['confidence']
    if type(primary) is not str or primary not in LABELS:
        return False
    if type(confidence) is not str or confidence not in {'moderate', 'high'}:
        return False
    if 'secondary' not in expression:
        return True
    secondary = expression['secondary']
    return type(secondary) is str and secondary in LABELS and secondary != primary


def discard(path):
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def ordinary_directory(path):
    info = path.lstat()
    return (stat.S_ISDIR(info.st_mode) and
            not (getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT))


def prune(directory, now):
    pending = 0
    for count, path in enumerate(directory.iterdir()):
        if count >= 32:
            return MAX_PENDING
        if not OWNED_NAME.fullmatch(path.name):
            continue
        try:
            age = now - path.lstat().st_mtime
        except FileNotFoundError:
            continue
        if age >= TTL or age < -TTL:
            discard(path)
        else:
            pending += 1
    return pending


def stage(profile, session_id, expression):
    if not valid(expression):
        return None
    loop = asyncio.get_running_loop()
    directory = profile / 'runtime' / 'stellar-voice-expression'
    if not installed(profile):
        return None
    nonce = secrets.token_hex(16)
    temporary, staged = directory / (nonce + '.tmp'), directory / (nonce + '.json')
    created = False
    try:
        if not ordinary_directory(directory.parent):
            return None
        directory.mkdir(exist_ok=True)
        now = time.time()
        if not ordinary_directory(directory) or prune(directory, now) >= MAX_PENDING:
            return None
        payload = {'version': 1, 'session_id': session_id,
                   'expires_unix_ms': int((now + TTL) * 1000), 'expression': expression}
        raw = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        if len(raw) > 1024:
            return None
        with temporary.open('xb') as stream:
            created = True
            stream.write(raw)
        temporary.rename(staged)
        loop.call_later(TTL, discard, staged)
        return f'[[stellar-desktop-voice-expression:{nonce}]]\n', staged
    except OSError:
        return None
    finally:
        if created:
            discard(temporary)
