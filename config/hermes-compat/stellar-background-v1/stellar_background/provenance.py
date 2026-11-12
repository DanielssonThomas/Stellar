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
