"""Version-pinned reversible package executable ONLY against enrolled disposable copies.

This is not a production installer or authorization to patch managed Hermes. Retained v1
receipts require a denial/provenance fence after producer removal; bare stock restoration is
allowed only when no v1 event identity exists. Database/custody records are never rolled back.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import secrets

from .contract import ContractError
from .lifecycle import custody, disable
from .overlay import ROOT, transformed
from .package_io import atomic, digest, exclusive, read_json, remove_owned, safe_root, within, write_json
from .provenance import verify_runtime
from .schema import install_schema

PREFIX = 'runtime/stellar_background_compat'
MARKER = 'stellar-disposable-package.json'
FENCE_INIT = b'"""Retained denial/receipt fence. Producer removed; no activation or private authority."""\n'


def payload():
    values = {p.name: p.read_bytes() for p in ROOT.glob('*.json')}
    values.update({p.name: p.read_bytes() for p in ROOT.glob('*.py')})
    values.update({'stellar_background/' + p.name: p.read_bytes() for p in (ROOT / 'stellar_background').glob('*.py')})
    return values


def package_digest():
    return digest(json.dumps({n: digest(v) for n, v in payload().items()}, sort_keys=True).encode())


def fence_payload():
    full = payload()
    return {'contract-v1.json': full['contract-v1.json'], 'host-interface-v1.json': full['host-interface-v1.json'],
            'stellar_background/__init__.py': FENCE_INIT,
            'stellar_background/contract.py': full['stellar_background/contract.py'],
            'stellar_background/wiring.py': full['stellar_background/wiring.py']}


def enroll(source, destination):
    root, source = safe_root(destination), Path(source).resolve(strict=True)
    if any(root.iterdir()) or root.is_relative_to(source) or source.is_relative_to(root):
        raise ContractError('fresh_disposable_required')
    verify_runtime(source)
    pin = json.loads((ROOT / 'runtime-pin.json').read_text(encoding='utf-8'))
    # Validate the whole source transformation before the first output write.
    changes = transformed(source)
    for name in [*pin['files'], 'install-stamp.json']:
        atomic(root, 'runtime/' + name, (source / name).read_bytes())
    for name in changes:
        atomic(root, 'backup/' + name, (source / name).read_bytes())
    for name, data in payload().items():
        atomic(root, 'bundle/' + name, data)
    state = {'schemaVersion': 1, 'kind': 'disposable_only', 'root': str(root), 'nonce': secrets.token_hex(32),
             'source': str(source), 'packageDigest': package_digest(), 'phase': 'prepared'}
    write_json(root, MARKER, state)
    return Package(root)


class Package:
    def __init__(self, root):
        self.root = safe_root(root)
        self.state = read_json(self.root, MARKER)
        if (set(self.state) != {'schemaVersion', 'kind', 'root', 'nonce', 'source', 'packageDigest', 'phase'}
                or self.state['schemaVersion'] != 1 or self.state['kind'] != 'disposable_only'
                or self.state['root'] != str(self.root) or len(self.state['nonce']) != 64
                or self.state['packageDigest'] != package_digest()):
            raise ContractError('enrollment_mismatch')
        self.pin = json.loads((ROOT / 'runtime-pin.json').read_text(encoding='utf-8'))
        self.post = json.loads((ROOT / 'postimages.json').read_text(encoding='utf-8'))['files']
        folder = within(self.root, 'bundle')
        actual = {str(p.relative_to(folder)).replace('\\', '/') for p in folder.rglob('*') if p.is_file()}
        if actual != set(payload()) or any(within(self.root, 'bundle/' + n).read_bytes() != data for n, data in payload().items()):
            raise ContractError('bundle_mismatch')

    @property
    def runtime(self):
        return within(self.root, 'runtime')

    @property
    def db_path(self):
        return within(self.root, 'state/canonical.db')

    def _db(self, db):
        if Path(db.db_path).resolve(strict=True) != self.db_path:
            raise ContractError('foreign_database_refused')
        within(self.root, 'state/canonical.db')

    def _db_identity(self, db, *, fresh=False):
        self._db(db)
        with db._read_ctx() as conn:
            exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stellar_bg_installation_v1'").fetchone()
            if exists is None:
                if fresh:
                    return
                raise ContractError('database_package_mismatch')
            row = conn.execute('SELECT phase,package_digest FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
        expected = {'prepared': ('unmanaged_candidate', ''), 'installing': ('installing', self.state['packageDigest']),
            'installed': ('active_candidate', self.state['packageDigest']), 'disabling': ('disabling', self.state['packageDigest']),
            'disabled': ('disabled', self.state['packageDigest']), 'removing': ('removing', self.state['packageDigest']),
            'rolling_back': ('rolling_back', self.state['packageDigest']),
            'removed': ('removed', self.state['packageDigest']), 'fenced': ('fenced', self.state['packageDigest'])}
        if row is None or tuple(row) != expected.get(self.state['phase']):
            raise ContractError('database_package_mismatch')

    def _phase(self, phase):
        self.state['phase'] = phase
        write_json(self.root, MARKER, self.state)

    def _refresh(self):
        self.state = Package(self.root).state

    def _sources(self, allowed):
        for name, before in self.pin['files'].items():
            actual = digest(within(self.root, 'runtime/' + name).read_bytes())
            values = {before} if allowed == 'base' else {self.post.get(name, {}).get('after', before)}
            if allowed == 'mixed':
                values.add(before)
            if actual not in values:
                raise ContractError('source_mismatch')
        for name, hashes in self.post.items():
            if digest(within(self.root, 'backup/' + name).read_bytes()) != hashes['before']:
                raise ContractError('backup_mismatch')

    def _package(self, expected, *, partial=False):
        folder = within(self.root, PREFIX)
        actual = {str(p.relative_to(folder)).replace('\\', '/') for p in folder.rglob('*') if p.is_file()} if folder.exists() else set()
        if (not actual <= set(expected)) or (not partial and actual != set(expected)):
            raise ContractError('package_mismatch')
        for name in actual:
            if within(self.root, PREFIX + '/' + name).read_bytes() != expected[name]:
                raise ContractError('package_mismatch')

    def _quiet(self, db):
        self._db(db)
        with db._read_ctx() as conn:
            facts = custody(conn)
        if facts['unfinishedEffects'] or facts['executions'] or facts['workers']:
            raise ContractError('custody_or_execution_pending')
        return facts

    def _set_db_phase(self, db, phase):
        def write(conn):
            row = conn.execute('SELECT package_digest FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
            if row[0] not in ('', self.state['packageDigest']):
                raise ContractError('database_package_mismatch')
            conn.execute('UPDATE stellar_bg_installation_v1 SET phase=?,package_digest=? WHERE singleton=1',
                         (phase, self.state['packageDigest']))
        db._execute_write(write)

    def _begin_disabled(self, db, phase):
        def write(conn):
            row = conn.execute('SELECT package_digest FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
            if row is None or row[0] not in ('', self.state['packageDigest']):
                raise ContractError('database_package_mismatch')
            disable(conn)
            conn.execute('UPDATE stellar_bg_installation_v1 SET phase=?,package_digest=? WHERE singleton=1',
                         (phase, self.state['packageDigest']))
        db._execute_write(write)

    def install(self, db, *, failpoint=lambda phase: None):
        with exclusive(self.root):
            self._refresh()
            self._db(db)
            if self.state['phase'] not in ('prepared', 'installing', 'removed'):
                raise ContractError('package_phase_refused')
            self._db_identity(db, fresh=self.state['phase'] == 'prepared')
            self._sources('mixed' if self.state['phase'] == 'installing' else 'base')
            self._package(payload(), partial=True)
            install_schema(db)
            self._quiet(db)
            # Deny in the same canonical DB before touching code; never reactivate prior grants.
            self._begin_disabled(db, 'installing')
            failpoint('install_db_intent')
            self._phase('installing')
            failpoint('install_intent')
            # Derive transformations from retained verified original bytes, not a mutable source.
            spec = json.loads((ROOT / 'patch-spec.json').read_text(encoding='utf-8'))
            values = {n: within(self.root, 'backup/' + n).read_bytes().decode('utf-8') for n in self.post}
            for change in spec['changes']:
                if values[change['path']].count(change['before']) != 1:
                    raise ContractError('patch_context_mismatch')
                values[change['path']] = values[change['path']].replace(change['before'], change['after'], 1)
            for name, value in values.items():
                if digest(value.encode()) != self.post[name]['after']:
                    raise ContractError('postimage_mismatch')
            for name, data in payload().items():
                atomic(self.root, PREFIX + '/' + name, data)
            for name, value in values.items():
                atomic(self.root, 'runtime/' + name, value.encode())
                failpoint('installed:' + name)
            self._sources('post')
            self._package(payload())
            self._set_db_phase(db, 'active_candidate')
            failpoint('install_db_active')
            self._phase('installed')
            return self.verify(db)

    def verify(self, db):
        self._refresh()
        self._db(db)
        phase = self.state['phase']
        if phase in ('installed', 'disabled'):
            self._sources('post'); self._package(payload())
        elif phase == 'fenced':
            self._sources('post'); self._package(fence_payload())
        elif phase == 'removed':
            self._sources('base'); self._package({})
        else:
            raise ContractError('package_phase_refused')
        with db._read_ctx() as conn:
            row = conn.execute('SELECT phase,package_digest FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
        expected = 'active_candidate' if phase == 'installed' else phase
        if row is None or tuple(row) != (expected, self.state['packageDigest']):
            raise ContractError('database_package_mismatch')
        return {'phase': phase, 'disposableOnly': True, 'installedCapability': False, 'databaseRetained': True,
                'packageDigest': self.state['packageDigest']}

    def disable(self, db):
        with exclusive(self.root):
            self._refresh()
            self._db(db)
            if self.state['phase'] not in ('installed', 'disabled', 'disabling'):
                raise ContractError('package_phase_refused')
            self._db_identity(db)
            self._phase('disabling')
            self._set_db_phase(db, 'disabling')
            result = db._execute_write(disable)
            host = getattr(db, '_stellar_background_host', None)
            if host is not None:
                host.detach()
            self._phase('disabled')
            return {'phase': 'disabled', 'bindings': result, 'installedCapability': False}

    def remove(self, db, *, restore_base=False, failpoint=lambda phase: None):
        with exclusive(self.root):
            self._refresh()
            self._db(db)
            if self.state['phase'] not in ('disabled', 'removing', 'fenced'):
                raise ContractError('package_phase_refused')
            self._db_identity(db)
            facts = self._quiet(db)
            if restore_base and facts['events']:
                raise ContractError('retained_provenance_requires_fence')
            if self.state['phase'] == 'fenced':
                return self.verify(db)  # already removed; do not create a new removal intent
            fenced = facts['events'] > 0
            self._sources('post' if fenced or self.state['phase'] != 'removing' else 'mixed')
            full, keep = payload(), fence_payload() if fenced else {}
            # Resumable fence transition accepts only old/new known package bytes.
            folder = within(self.root, PREFIX)
            expected = {n: {digest(v), digest(keep[n])} if n in keep else {digest(v)} for n, v in full.items()}
            for path in folder.rglob('*'):
                if path.is_file():
                    name = str(path.relative_to(folder)).replace('\\', '/')
                    if name not in expected or digest(within(self.root, PREFIX + '/' + name).read_bytes()) not in expected[name]:
                        raise ContractError('package_mismatch')
            self._set_db_phase(db, 'removing')
            failpoint('remove_db_intent')
            self._phase('removing')
            failpoint('remove_intent')
            for name, data in keep.items():
                atomic(self.root, PREFIX + '/' + name, data)
            for name, data in full.items():
                if name not in keep:
                    target = within(self.root, PREFIX + '/' + name)
                    if target.exists():
                        target.unlink()
            if not fenced:
                for name in self.post:
                    atomic(self.root, 'runtime/' + name, within(self.root, 'backup/' + name).read_bytes())
                    failpoint('restored:' + name)
                remove_owned(self.root, PREFIX, {})
            phase = 'fenced' if fenced else 'removed'
            self._set_db_phase(db, phase)
            failpoint('remove_db_complete')
            self._phase(phase)
            return self.verify(db)

    def rollback_install(self, db, *, failpoint=lambda phase: None):
        with exclusive(self.root):
            self._refresh()
            self._db(db)
            if self.state['phase'] not in ('installing', 'rolling_back'):
                raise ContractError('package_phase_refused')
            self._db_identity(db)
            if self._quiet(db)['events']:
                raise ContractError('retained_provenance_requires_fence')
            self._sources('mixed'); self._package(payload(), partial=True)
            self._begin_disabled(db, 'rolling_back')
            failpoint('rollback_db_intent')
            self._phase('rolling_back')
            for name in self.post:
                atomic(self.root, 'runtime/' + name, within(self.root, 'backup/' + name).read_bytes())
                failpoint('rollback_restored:' + name)
            remove_owned(self.root, PREFIX, {n: digest(v) for n, v in payload().items()})
            self._set_db_phase(db, 'removed'); self._phase('removed')
            return self.verify(db)

    def recover(self, db):
        from .package_recovery import recover
        return recover(self, db)

    @contextmanager
    def runtime_use(self, db):
        """Fixture child holds this lease for its entire loaded-runtime lifetime."""
        with exclusive(self.root):
            self._refresh()
            self.verify(db)
            yield self.runtime / 'stellar_background_compat'
