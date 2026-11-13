"""Read-only runtime pin verification. Passing this check never grants integration readiness."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath

from .contract import ContractError


def verify_runtime(root: Path, *, pin_path: Path | None = None):
    root = root.resolve(strict=True)
    pin_path = pin_path or Path(__file__).resolve().parents[1] / 'runtime-pin.json'
    try:
        pin = json.loads(pin_path.read_text(encoding='utf-8'))
        stamp = json.loads((root / 'install-stamp.json').read_text(encoding='utf-8-sig'))
        if (pin['schemaVersion'] != 1 or stamp['commit'] != pin['commit']
                or stamp['baseVersion'] != pin['version']):
            raise ContractError('runtime_mismatch')
        for name, expected in pin['files'].items():
            relative = PurePosixPath(name)
            if relative.is_absolute() or '..' in relative.parts or '\\' in name:
                raise ContractError('invalid_pin')
            path = (root / name).resolve(strict=True)
            if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise ContractError('runtime_mismatch')
    except (KeyError, TypeError, ValueError, OSError) as exc:
        if isinstance(exc, ContractError):
            raise
        raise ContractError('runtime_unavailable') from None
    return {'schemaVersion': 1, 'version': pin['version'], 'commit': pin['commit'],
            'filesVerified': len(pin['files']), 'installedCapability': False,
            'reason': 'host_and_consumer_wiring_required'}


def verify_candidate(root: Path, *, bootstrap_root: Path | None = None, facts_path: Path | None = None):
    """Require complete pinned postimages before host composition; never applies them."""
    root = root.resolve(strict=True)
    package = Path(__file__).resolve().parents[1]
    pin = json.loads((package / 'runtime-pin.json').read_text(encoding='utf-8'))
    post = json.loads((package / 'postimages.json').read_text(encoding='utf-8'))['files']
    if (bootstrap_root is None) != (facts_path is None):
        raise ContractError('runtime_mismatch')
    stamp_root = root
    if bootstrap_root is not None:
        # Managed dependency workspaces have no install stamp of their own. Require the
        # coordinator's explicit read-only provenance chain; never discover/fallback to a profile.
        stamp_root = bootstrap_root.resolve(strict=True)
        facts = json.loads(facts_path.read_text(encoding='utf-8'))
        selected = facts['packages']['venv']
        environment, lock = Path(selected['environment']), Path(selected['resolved_lock'])
        if not environment.is_absolute() or not lock.is_absolute():
            raise ContractError('runtime_mismatch')
        try:
            environment, lock = environment.resolve(strict=True), lock.resolve(strict=True)
        except OSError:
            raise ContractError('runtime_unavailable') from None
        if (not environment.is_dir() or not lock.is_file() or environment.parent != root.parent
                or environment.name != 'venv' or lock != root / 'uv.lock'):
            raise ContractError('runtime_mismatch')
    stamp = json.loads((stamp_root / 'install-stamp.json').read_text(encoding='utf-8-sig'))
    if stamp.get('commit') != pin['commit'] or stamp.get('baseVersion') != pin['version']:
        raise ContractError('runtime_mismatch')
    for name, before in pin['files'].items():
        path = (root / name).resolve(strict=True)
        expected = post[name]['after'] if name in post else before
        if (not path.is_relative_to(root) or (name in post and post[name]['before'] != before)
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected):
            raise ContractError('runtime_mismatch')
    import hermes_state_runtime  # canonical owner must already load from this pinned root
    from .loaded import verify_loaded
    checked = verify_loaded(root)
    return {'schemaVersion': 1, 'filesVerified': len(pin['files']), 'installedCapability': False,
            'loadedCallSitesVerified': checked, 'reason': 'native_consumer_and_application_qualification_required'}
