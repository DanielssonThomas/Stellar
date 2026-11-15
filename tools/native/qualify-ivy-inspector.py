"""Read-only installed-source qualification. Prints availability and counts, never private content."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
logging.disable(logging.CRITICAL)
PROFILE = Path('D:/Hermes/profiles/ivy')
ROOT = Path(__file__).resolve().parents[2]
os.environ['HERMES_HOME'] = str(PROFILE)
os.environ.pop('HERMES_TUI_GATEWAY_URL', None)
sys.path.insert(0, 'D:/Hermes/hermes-agent')
for name, filename in [('stellar_ivy_inspector_history', 'ivy_inspector_history.py'), ('stellar_ivy_inspector', 'ivy_inspector.py')]:
    spec = importlib.util.spec_from_file_location(name, ROOT / 'apps/stellar-desktop/src-tauri/src/ivy' / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
history = sys.modules['stellar_ivy_inspector_history']
inspector = sys.modules['stellar_ivy_inspector']


def digest(path):
    return hashlib.sha256(path.read_bytes()).digest() if path.exists() else None


async def qualify():
    auth = PROFILE / 'auth.json'
    auth_before = digest(auth)
    active = None
    journal = Path(os.environ['LOCALAPPDATA']) / 'dev.stellar.desktop/ivy/ivy-session.json'
    try:
        active = json.loads(journal.read_text(encoding='utf-8')).get('session_id')
    except (OSError, ValueError):
        pass
    stored = history.read_history(PROFILE, active, None)
    if not stored['messages']:
        nonempty = next((row for row in stored['sessions'] if row['message_count'] > 0), None)
        if nonempty:
            stored = history.read_history(PROFILE, active, nonempty['id'])
    result = {'issue': 302, 'measured_at': datetime.now(timezone.utc).isoformat(),
              'history_available': stored['history_available'], 'catalog_page_count': len(stored['sessions']),
              'transcript_page_count': len(stored['messages']),
              'native_journal_present': journal.exists(), 'active_session_present': active is not None,
              'active_stored_identity_resolved': active is not None and stored['active_stored_session_id'] is not None,
              'gateway_available': False, 'context_available': False, 'account_usage_available': False,
              'inference_requests': 0, 'session_resume_requests': 0}
    try:
        from hermes_cli.gateway_runtime import discover_gateway_endpoint
        from hermes_cli.gateway_client import connect_gateway
        found = await asyncio.to_thread(discover_gateway_endpoint, PROFILE, timeout=2)
        result['gateway_discovery_state'] = found.state
        if found.state == 'ready' and found.endpoint is not None:
            async with connect_gateway(found.endpoint) as client:
                result['gateway_available'] = True
                if active:
                    stats = await asyncio.wait_for(client.rpc('session.stats', session_id=active), 3)
                    result['context_available'] = bool(stats.get('context_length')) and type(stats.get('context_tokens')) is int
    except Exception as error:
        result['gateway_error_kind'] = type(error).__name__
    try:
        account = await asyncio.to_thread(inspector.Inspector._fetch_account)
        result['account_usage_available'] = bool(account and account['state'] == 'available')
    except Exception:
        pass
    result['auth_store_unchanged'] = auth_before == digest(auth)
    result['limitations'] = ['Availability qualification is read-only; it starts no inference, attaches no session and does not measure physical audio.',
                            'Context may be unavailable when the retained session has no live agent; account usage may be unavailable when its source cannot answer.']
    output = ROOT / 'tools/native/evidence/ivy-inspector-qualification.json'
    output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    asyncio.run(qualify())
