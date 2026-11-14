"""Build/undo disposable source fixtures only. This is not a managed install command."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import tempfile

from .contract import ContractError
from .provenance import verify_runtime


ROOT = Path(__file__).resolve().parents[1]


def transformed(runtime):
    verify_runtime(runtime)
    result = {}
    for change in json.loads((ROOT / 'patch-spec.json').read_text(encoding='utf-8'))['changes']:
        name = change['path']
        value = result.get(name, (runtime / name).read_text(encoding='utf-8'))
        if value.count(change['before']) != 1:
            raise ContractError('patch_context_mismatch')
        result[name] = value.replace(change['before'], change['after'], 1)
    for name, value in result.items():
        compile(value, name, 'exec')
    return result


def fixture(runtime, destination):
    """Only an empty real temporary directory; never resolve a managed runtime as output."""
    runtime, destination = Path(runtime).resolve(strict=True), Path(destination).resolve(strict=True)
    temporary = Path(tempfile.gettempdir()).resolve(strict=True)
    if (not destination.is_relative_to(temporary) or destination == temporary
            or destination.is_relative_to(runtime) or runtime.is_relative_to(destination)
            or any(destination.iterdir())):
        raise ContractError('fixture_destination_refused')
    changes = transformed(runtime)
    pin = json.loads((ROOT / 'runtime-pin.json').read_text(encoding='utf-8'))
    manifest = {'schemaVersion': 1, 'installedCapability': False, 'files': {}}
    for name in [*pin['files'], 'install-stamp.json']:
        source, target = runtime / name, destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        data = source.read_bytes()
        target.write_bytes(data)
        if name in changes:
            target.write_bytes(changes[name].encode('utf-8'))
            manifest['files'][name] = {'before': hashlib.sha256(data).hexdigest(),
                                      'after': hashlib.sha256(target.read_bytes()).hexdigest()}
    # Remaining imports use the unchanged runtime via sys.path; this is a source fixture,
    # not a second executable installation or profile. No package/bootstrap is registered.
    return manifest


def undo_fixture(runtime, destination, manifest):
    runtime, destination = Path(runtime).resolve(strict=True), Path(destination).resolve(strict=True)
    temporary = Path(tempfile.gettempdir()).resolve(strict=True)
    if not destination.is_relative_to(temporary) or destination == temporary or destination == runtime:
        raise ContractError('fixture_destination_refused')
    expected = {name: {'before': hashlib.sha256((runtime / name).read_bytes()).hexdigest(),
                       'after': hashlib.sha256(value.encode('utf-8')).hexdigest()}
                for name, value in transformed(runtime).items()}
    if manifest.get('files') != expected:
        raise ContractError('rollback_mismatch')
    # Verify every postimage before the first mutation. Never overwrite an unknown later change.
    for name, hashes in manifest['files'].items():
        if (name not in json.loads((ROOT / 'runtime-pin.json').read_text(encoding='utf-8'))['files']
                or not (destination / name).resolve(strict=True).is_relative_to(destination)
                or hashlib.sha256((destination / name).read_bytes()).hexdigest() != hashes['after']
                or hashlib.sha256((runtime / name).read_bytes()).hexdigest() != hashes['before']):
            raise ContractError('rollback_mismatch')
    for name in manifest['files']:
        shutil.copyfile(runtime / name, destination / name)
    return verify_runtime(destination)
