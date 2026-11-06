"""Read-only session inspection. Quota refresh never blocks the foreground gateway worker."""
from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime, timezone

from stellar_ivy_inspector_history import read_history, text


def now():
    return datetime.now(timezone.utc).isoformat()


def count(value):
    return value if type(value) is int and 0 <= value <= 4294967295 else None


class Inspector:
    def __init__(self, profile):
        self.profile = profile
        self.account = {'state': 'loading', 'observed_at': None, 'windows': []}
        self.refreshed = 0
        self.task = None
        self.context_task = None
        self.context_active = None
        self.context = {'observed_at': None, 'used': None, 'limit': None, 'compactions': None}

    async def close(self):
        for task in (self.task, self.context_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    def refresh_account(self):
        if (self.task is None or self.task.done()) and time.monotonic() - self.refreshed > 60:
            self.refreshed = time.monotonic()
            self.task = asyncio.create_task(self._account())

    async def _account(self):
        try:
            result = await asyncio.to_thread(self._fetch_account)
        except Exception:
            result = None
        self.account = result or {'state': 'unavailable', 'observed_at': now(), 'windows': []}

    @staticmethod
    def _fetch_account():
        from hermes_cli.auth import resolve_codex_runtime_credentials
        from agent.account_usage import fetch_account_usage
        credentials = resolve_codex_runtime_credentials(read_only=True, refresh_if_expiring=False)
        if not isinstance(credentials.get('api_key'), str) or not credentials['api_key'].strip():
            return None
        usage = fetch_account_usage('openai-codex', api_key=credentials['api_key'],
                                    base_url=credentials.get('base_url'), read_only=True)
        if usage is None:
            return None
        windows = []
        for window in usage.windows[:8]:
            value = window.used_percent
            value = float(value) if type(value) in (int, float) and math.isfinite(value) else None
            windows.append({'label': text(window.label, 80),
                            'used_percent': max(0, min(100, value)) if value is not None else None,
                            'reset_at': window.reset_at.isoformat() if window.reset_at else None,
                            'scope': 'model' if window.scope == 'model' else 'account'})
        return {'state': 'available' if usage.available and windows else 'unavailable',
                'observed_at': usage.fetched_at.isoformat(), 'windows': windows}

    async def inspect(self, conn, active, requested, offset, before, redact):
        self.refresh_account()
        history = await asyncio.to_thread(read_history, self.profile, active, requested, offset, before, redact)
        identity = (active, history['active_stored_session_id'])
        if identity != self.context_active:
            self.context_active = identity
            self.context = {'observed_at': None, 'used': None, 'limit': None, 'compactions': None}
            if self.context_task is not None:
                self.context_task.cancel()
                self.context_task = None
        if active and (self.context_task is None or self.context_task.done()):
            self.context_task = asyncio.create_task(self._context(conn, active, identity))
        return {'version': 1, 'observed_at': now(), 'active_session_id': active,
                **history, 'context': self.context, 'account': self.account}

    async def _context(self, conn, active, identity):
        try:
            stats = await asyncio.wait_for(conn.client.rpc('session.stats', session_id=active), 2)
            maximum = count(stats.get('context_length'))
            if identity == self.context_active:
                self.context = {'observed_at': now(), 'used': count(stats.get('context_tokens')) if maximum else None,
                                'limit': maximum or None, 'compactions': count(stats.get('compression_count'))}
        except Exception:
            if identity == self.context_active:
                self.context = {'observed_at': now(), 'used': None, 'limit': None, 'compactions': None}
