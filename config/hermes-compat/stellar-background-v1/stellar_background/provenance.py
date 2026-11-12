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


def verify_candidate(root: Path):
    """Require complete pinned postimages before host composition; never applies them."""
    root = root.resolve(strict=True)
    package = Path(__file__).resolve().parents[1]
    pin = json.loads((package / 'runtime-pin.json').read_text(encoding='utf-8'))
    post = json.loads((package / 'postimages.json').read_text(encoding='utf-8'))['files']
    stamp = json.loads((root / 'install-stamp.json').read_text(encoding='utf-8-sig'))
    if stamp.get('commit') != pin['commit'] or stamp.get('baseVersion') != pin['version']:
        raise ContractError('runtime_mismatch')
    for name, before in pin['files'].items():
        path = (root / name).resolve(strict=True)
        expected = post[name]['after'] if name in post else before
        if (not path.is_relative_to(root) or (name in post and post[name]['before'] != before)
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected):
            raise ContractError('runtime_mismatch')
    # Prove the executing canonical functions, not merely updated files under an old process.
    import hermes_state_runtime as runtime
    if Path(runtime.__file__).resolve() != root / 'hermes_state_runtime.py':
        raise ContractError('runtime_mismatch')
    compiled = compile(Path(runtime.__file__).read_text(encoding='utf-8'), runtime.__file__, 'exec', dont_inherit=True)
    for name in ('claim_session_input', 'settle_session_input', 'resolve_unknown_session_input'):
        code = next(c for c in compiled.co_consts if hasattr(c, 'co_name') and c.co_name == name)
        if getattr(runtime, name).__code__ != code:
            raise ContractError('loaded_runtime_mismatch')
    return {'schemaVersion': 1, 'filesVerified': len(pin['files']), 'installedCapability': False,
            'reason': 'native_consumer_and_application_qualification_required'}
