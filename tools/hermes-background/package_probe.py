"""Cold fixture probe. Not a model/native identity/consent or managed bootstrap qualification."""
from __future__ import annotations

import argparse
import asyncio
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[2]
CANDIDATE = REPO / 'config/hermes-compat/stellar-background-v1'


def load_operator():
    name = 'stellar_fixture_operator'
    spec = importlib.util.spec_from_file_location(name, CANDIDATE / 'stellar_background/__init__.py',
        submodule_search_locations=[str(CANDIDATE / 'stellar_background')])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    from stellar_fixture_operator.package import Package
    return Package


def run(root, source, mode):
    Package = load_operator()
    package = Package(root)
    from stellar_fixture_operator.package_io import within
    home = within(package.root, 'fixture-home')
    home.mkdir(exist_ok=True)
    for key in ('HERMES_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'):
        os.environ[key] = str(home)
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(package.runtime / 'stellar_background_compat'), str(package.runtime), str(source)]
    names = set(json.loads((CANDIDATE / 'runtime-pin.json').read_text(encoding='utf-8'))['files'])
    class Copies(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname in ('hermes_bootstrap', 'gateway.run', 'run_agent'):
                raise RuntimeError('No gateway bootstrap/model in disposable package probe')
            relative = fullname.replace('.', '/') + '.py'
            if relative in names:
                return importlib.util.spec_from_file_location(fullname, package.runtime / relative)
            return None
    sys.meta_path.insert(0, Copies())
    def offline(event, arguments):
        if event == 'socket.connect' and isinstance(arguments[1], tuple) and arguments[1][0] in ('127.0.0.1', '::1'):
            return
        if event in ('socket.connect', 'subprocess.Popen', 'os.system', 'os.exec'):
            raise RuntimeError('External network/process disabled in fixture probe')
    sys.addaudithook(offline)
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch, admit_session_input, claim_session_input, settle_session_input
    db = SessionDB(package.db_path)
    try:
        with package.runtime_use(db):
            if db.get_session('original') is None:
                db.create_session('original', source='local')
            if mode == 'foreground':
                epoch = begin_runtime_epoch(db, instance_id='disposable-foreground')
                row = admit_session_input(db, epoch=epoch, session_id='original', principal_id='fixture-human',
                    request_id='fixture-human-after-remove', payload={'text': 'ordinary fixture'})
                claimed = claim_session_input(db, epoch=epoch, session_id='original')
                settled = settle_session_input(db, epoch=epoch, admission_id=claimed['admission_id'],
                    generation=claimed['generation'], outcome='completed', result={'result': {'final_response': 'fixture foreground'}})
                return {'humanAdmissionMatches': row['admission_id'] == settled['admission_id'], 'outcome': settled['outcome']}
            if mode == 'fence':
                from stellar_background.wiring import receipt, negotiation
                with db._read_ctx() as conn:
                    saved = conn.execute('SELECT a.admission_id FROM session_admissions a JOIN stellar_bg_events_v1 e '
                        'ON a.request_id=e.request_id ORDER BY a.seq LIMIT 1').fetchone()
                connection = SimpleNamespace(authority=SimpleNamespace(db=db))
                out = receipt(connection, SimpleNamespace(session_id='original'), saved[0], {'status': 'terminal'})
                return {'marker': out['background_v1'], 'delivery': out['background_delivery_authorized'],
                    'describe': negotiation({'capabilities': []}), 'producerModuleAbsent': not (package.runtime / 'stellar_background_compat/stellar_background/host.py').exists()}
            from stellar_background.host import Host
            from gateway.session_contract import SessionActor
            now, gesture = 1700000000000, object()
            epoch = begin_runtime_epoch(db, instance_id='disposable-host-fixture')
            actor = SessionActor('synthetic-native-owner', 'fixture-ivy', frozenset({'session:control', 'session:read'}), 'fixture-transport')
            authority = SimpleNamespace(db=db, profile_id='fixture-ivy', epoch=epoch, runner=SimpleNamespace(),
                sessions={'original': SimpleNamespace(route='fixture-route', detached=False)}, events={'fixture-transport': object()},
                _native_legacy_transports={'fixture-transport': actor}, _require_admission_open=lambda: None,
                physical_target=lambda ref: db.get_compression_tip(ref.session_id), _publish_pending=lambda ref: None,
                _schedule_admitted=lambda ref, value: None)
            def authorize(a, ref, capability):
                if a is not actor or ref.session_id != 'original' or capability not in actor.capabilities:
                    raise ValueError('fixture permission refused')
            authority.authorize = authorize
            connection = SimpleNamespace(authority=authority, actor=actor, subscriptions={'original': 'fixture-subscription'})
            host = Host(authority, runtime_root=package.runtime, verify_native=lambda c: c is connection,
                verify_gesture=lambda c, r, o, g: g is gesture, policy_gate=lambda c, b, v: v == 'fixture-v1', clock=lambda: now)
            db._stellar_background_host = host
            producer = host.register_producer('stellar-herdr', version='fixture-v1', incarnation='a' * 32)
            ticket = host.approve(connection, 'original', producer_id='stellar-herdr', expires_at=now+600000,
                                  max_admissions=3, gesture=gesture)
            binding = host.bind(connection, 'original', ticket)
            event = {'schemaVersion': 1, 'eventId': 'disposable-event', 'kind': 'lifecycle_update',
                'payload': {'milestone': 'waiting_review', 'observedAt': now, 'fact': {'fixture': True}}}
            prepared = producer.prepare(binding['bindingId'], event)
            submitted = asyncio.run(producer.submit(binding['bindingId'], prepared['event']))
            row = claim_session_input(db, epoch=epoch, session_id='original')
            settle_session_input(db, epoch=epoch, admission_id=row['admission_id'], generation=row['generation'],
                                 outcome='completed', result={'result': {'final_response': 'synthetic fixture answer'}})
            return {'syntheticNativeFixture': True, 'genuineConsent': False, 'binding': binding,
                    'event': event, 'digest': prepared['digest'], 'admission': submitted['receipt']['admission_id']}
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--mode', choices=('exercise', 'foreground', 'fence'), required=True)
    args = parser.parse_args()
    print(json.dumps({'disposableOnly': True, 'liveModelOrNotification': False,
        'result': run(args.root, args.source.resolve(strict=True), args.mode)}, ensure_ascii=False))
