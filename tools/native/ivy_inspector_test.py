import asyncio
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy'
for name, filename in [('stellar_ivy_inspector_history', 'ivy_inspector_history.py'), ('stellar_ivy_inspector', 'ivy_inspector.py')]:
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
history = sys.modules['stellar_ivy_inspector_history']
inspector = sys.modules['stellar_ivy_inspector']


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.profile = Path(self.folder.name)
        self.db = self.profile / 'state.db'
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('CREATE TABLE sessions(id TEXT,title TEXT,model TEXT,started_at REAL,last_activity_at REAL,message_count INTEGER,source TEXT,hidden INTEGER);'
                             'CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT);'
                             'CREATE TABLE state_meta(key TEXT,value TEXT);')
            db.executemany('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)',
                          [(f'local-{n}', f'Conversation {n}', 'terra', n+1, n+1, 2, 'local', 0) for n in range(45)]
                          + [('worker', 'Private worker', 'terra', 999, 999, 1, 'subagent', 0),
                             ('hidden', 'Hidden', 'terra', 999, 999, 1, 'local', 1)])
            db.executemany('INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(?,?,?,?,?)',
                          [(n+1, 'local-0', 'user' if n % 2 == 0 else 'assistant', f'Message {n}', n+1) for n in range(45)]
                          + [(46, 'local-0', 'system', 'Private instructions', 46),
                             (47, 'local-0', 'tool', 'Private tool output', 47)])

    def tearDown(self):
        self.folder.cleanup()

    def test_catalog_pagination_and_transcripts_are_read_only_and_never_attach(self):
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        first = history.read_history(self.profile, 'local-0', None)
        self.assertEqual(len(first['sessions']), 41)  # selected older active row is included
        self.assertEqual(first['selected_session_id'], 'local-0')
        self.assertEqual(first['active_stored_session_id'], 'local-0')
        self.assertEqual(first['next_offset'], 40)
        self.assertEqual(len(first['messages']), 40)
        self.assertNotIn('Private', json.dumps(first))
        earlier = history.read_history(self.profile, 'local-0', None, before=first['next_before'])
        self.assertEqual(len(earlier['messages']), 5)
        self.assertIsNone(earlier['next_before'])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)

    def test_transcript_skips_tool_only_assistant_rows_before_paging(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?)', [
                (101, 'local-1', 'user', 'Check the service', 101, None),
                (102, 'local-1', 'assistant', '', 102, '[{"id":"check"}]'),
                (103, 'local-1', 'assistant', 'I will check again.', 103, '[{"id":"retry"}]'),
                (104, 'local-1', 'assistant', ' \t\r\n', 104, '[{"id":"verify"}]'),
                (105, 'local-1', 'assistant', 'The service is responding.', 105, None),
                (106, 'local-1', 'assistant', '', 106, '[{"id":"log"}]'),
            ])

        with patch.object(history, 'PAGE', 2):
            recent = history.read_history(self.profile, None, 'local-1')
            self.assertEqual([m['id'] for m in recent['messages']], [103, 105])
            self.assertEqual([m['text'] for m in recent['messages']],
                             ['I will check again.', 'The service is responding.'])
            self.assertEqual(recent['next_before'], 103)
            earlier = history.read_history(self.profile, None, 'local-1', before=recent['next_before'])
            self.assertEqual([m['id'] for m in earlier['messages']], [101])
            self.assertIsNone(earlier['next_before'])

    def test_catalog_rejects_hidden_worker_and_unknown_transcript_selectors(self):
        for selected in ['worker', 'hidden', "local-0' OR 1=1", '../state.db']:
            result = history.read_history(self.profile, 'local-0', selected)
            self.assertIsNone(result['selected_session_id'])
            self.assertEqual(result['messages'], [])

    def test_runtime_identity_resolves_current_stored_segment_without_newest_fallback(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO state_meta VALUES(?,?)',
                       ('gateway.local_policy.v1:runtime', json.dumps({'entry': {'session_id': 'local-0'}})))
        result = history.read_history(self.profile, 'runtime', None)
        self.assertEqual(result['active_stored_session_id'], 'local-0')
        self.assertEqual(result['selected_session_id'], 'local-0')
        missing = history.read_history(self.profile, 'unknown-runtime', None)
        self.assertIsNone(missing['selected_session_id'])

    def test_structured_envelopes_large_content_and_workspace_tokens_are_not_exposed(self):
        values = [('{"stellar_presentation":{"secret":"private"}}', 'Presentation content'),
                  ('{"text":' + 'x' * 100000, 'Presentation content unavailable'),
                  ('{"text":"Visible answer","payload":"private"}', 'Visible answer')]
        for value, expected in values:
            self.assertEqual(history.visible_text(value), expected)
        self.assertEqual(history.visible_text('For workspace tool calls in this turn, pass turn_token exactly as private.\nUser request', 'user'), 'User request')
        self.assertEqual(history.visible_text(history.OBSERVATION_PREFIX + '{"desktop":{},"ivy":{}}\nUser request follows:\nOriginal request', 'user'), 'Original request')
        unrecognized = history.OBSERVATION_PREFIX + '{"unrecognized":true}\nUser request follows:\nOriginal request'
        self.assertEqual(history.visible_text(unrecognized, 'user'), unrecognized)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE messages SET content=? WHERE id=45', ('x' * 100000,))
        self.assertEqual(len(history.read_history(self.profile, 'local-0', None)['messages'][-1]['text']), 2000)

    def test_missing_database_is_unavailable_and_does_not_create_files(self):
        result = history.read_history(self.profile / 'absent', None, None)
        self.assertFalse(result['history_available'])
        self.assertFalse((self.profile / 'absent').exists())


class AsyncInspectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_quota_and_stats_do_not_block_inspection_and_are_owned(self):
        item = inspector.Inspector(Path('nonexistent-fixture'))
        entered = asyncio.Event()
        class Client:
            async def rpc(self, *_args, **_kwargs):
                entered.set()
                await asyncio.sleep(100)
        async def slow_account():
            await asyncio.sleep(100)
        item._account = slow_account
        start = time.monotonic()
        result = await item.inspect(types.SimpleNamespace(client=Client()), 'active', None, 0, None, lambda value: value)
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertIsNone(result['context']['used'])
        self.assertEqual(result['account']['state'], 'loading')
        await entered.wait()
        await item.close()
        self.assertTrue(item.task.cancelled())
        self.assertTrue(item.context_task.cancelled())

    async def test_context_refresh_is_fenced_when_active_session_changes(self):
        item = inspector.Inspector(Path('nonexistent-fixture'))
        item.refreshed = time.monotonic()
        class Client:
            async def rpc(self, _name, session_id):
                return {'context_tokens': 25 if session_id == 'new' else 90, 'context_length': 100, 'compression_count': 2}
        conn = types.SimpleNamespace(client=Client())
        await item.inspect(conn, 'old', None, 0, None, lambda value: value)
        await item.inspect(conn, 'new', None, 0, None, lambda value: value)
        await asyncio.sleep(0.01)
        self.assertEqual(item.context['used'], 25)
        self.assertIsNotNone(item.context['observed_at'])
        await item.close()

    def test_quota_uses_explicit_read_only_credentials_and_no_empty_fallback(self):
        auth = types.ModuleType('hermes_cli.auth')
        usage = types.ModuleType('agent.account_usage')
        calls = []
        auth.resolve_codex_runtime_credentials = lambda **kwargs: (calls.append(kwargs) or {'api_key': ''})
        usage.fetch_account_usage = lambda *_args, **_kwargs: self.fail('Blank credentials must not enter fallback resolution')
        with patch.dict(sys.modules, {'hermes_cli.auth': auth, 'agent.account_usage': usage}):
            self.assertIsNone(inspector.Inspector._fetch_account())
        self.assertEqual(calls, [{'read_only': True, 'refresh_if_expiring': False}])


if __name__ == '__main__':
    unittest.main()
