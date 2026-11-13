"""Materialize disconnected observer/runtime/consumer sources with exact immutable provenance."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REPO = Path(__file__).resolve().parents[2]
RUNTIME_BASE = '3b421578588243f920886e6fe79a6faa87ea026e'
PATCH = 'c0a21ab5118d6f7ab23b617e7ea2d2f81d072fa1d9fcd63ba0ba857d8d7356ce'
ROOT_BASE = '2bbff9fdcbee62df2287626567d14bed8776adad'
CONSUMER_BASE = 'e216f69d5c5dd2c70276115abea25db1dd1a94e6'
CONSUMER = 'b61907de4809e3f593adf65cdee7766db74c8e66'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, cwd=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, check=False, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[:4000])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    candidate, out = args.candidate.resolve(), args.out.absolute()
    scratch = Path('D:/Hermes/profiles/ivy/cache/scratch')
    if (out.parent != scratch or out.exists() or out.is_symlink() or out.is_junction()
            or any(parent.is_symlink() or parent.is_junction() for parent in out.parents)):
        raise ValueError('Qualification requires a fresh direct child of Ivy scratch without reparse paths')
    out.mkdir()
    manifest = json.loads((candidate / 'source-manifest.json').read_text())
    if manifest['base_commit'] != RUNTIME_BASE or digest(candidate / 'plugin-notification-candidate.patch') != PATCH:
        raise ValueError('The reviewed runtime candidate changed')
    runtime = out / 'runtime'
    runtime.mkdir()
    runtime_archive = out / 'runtime-base.tar'
    run(['git', '-C', 'D:/Hermes/hermes-agent', '-c', 'core.autocrlf=false', 'archive',
         '--format=tar', '--output=' + str(runtime_archive), RUNTIME_BASE])
    run(['tar', '-xf', runtime_archive, '-C', runtime])
    for row in manifest['files']:
        path = runtime / row['path']
        if row['new']:
            if path.exists():
                raise ValueError('New runtime path already exists: ' + row['path'])
        elif digest(path) != row['original_sha256']:
            raise ValueError('Runtime preimage changed: ' + row['path'])
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', candidate / 'plugin-notification-candidate.patch'], runtime)
    run(['git', '-c', 'core.autocrlf=false', 'apply', candidate / 'plugin-notification-candidate.patch'], runtime)
    for row in manifest['files']:
        if digest(runtime / row['path']) != row['candidate_sha256']:
            raise ValueError('Runtime postimage changed: ' + row['path'])
    consumer = out / 'consumer-lf'
    consumer.mkdir()
    stellar_archive = out / 'stellar-base-lf.tar'
    run(['git', '-c', 'core.autocrlf=false', 'archive', '--format=tar',
         '--output=' + str(stellar_archive), ROOT_BASE], REPO)
    run(['tar', '-xf', stellar_archive, '-C', consumer])
    patch = run(['git', 'diff', '--binary', '--full-index', CONSUMER_BASE, CONSUMER], REPO).stdout
    (out / 'consumer-b619.patch').write_bytes(patch)
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', out / 'consumer-b619.patch'], consumer)
    run(['git', '-c', 'core.autocrlf=false', 'apply', out / 'consumer-b619.patch'], consumer)
    changed = run(['git', 'diff', '--name-only', CONSUMER_BASE, CONSUMER], REPO).stdout.decode().splitlines()
    consumer_hashes = {}
    for relative in changed:
        expected = run(['git', 'show', CONSUMER + ':' + relative], REPO).stdout
        if (consumer / relative).read_bytes() != expected:
            raise ValueError('Consumer snapshot changed: ' + relative)
        consumer_hashes[relative] = hashlib.sha256(expected).hexdigest()
    source = REPO / 'config/hermes-plugins/stellar-herdr'
    observer = out / 'observer'
    observer.mkdir()
    observer_hashes = {}
    for path in source.iterdir():
        if path.name.startswith('test_') or (path.suffix != '.py' and path.name != 'plugin.yaml'):
            continue
        shutil.copyfile(path, observer / path.name)
        observer_hashes[path.name] = digest(path)
    test_source = REPO / 'tools/hermes-background/observer_composition_tests.py'
    target = runtime / 'tests/gateway/test_observer_notification_composition.py'
    if test_source.exists():
        shutil.copyfile(test_source, target)
    report = {'runtime_base': RUNTIME_BASE, 'runtime_patch_sha256': PATCH,
        'fresh_exports': True, 'runtime_archive_sha256': digest(runtime_archive),
        'stellar_archive_sha256': digest(stellar_archive),
        'runtime_postimages': manifest['files'], 'stellar_base': ROOT_BASE, 'consumer': CONSUMER,
        'consumer_hashes': consumer_hashes, 'observer_source': str(observer),
        'consumer_source': str(consumer), 'observer_hashes': observer_hashes,
        'composition_test_sha256': digest(test_source) if test_source.exists() else None,
        'operational': False}
    (out / 'composition-config.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'out': str(out), 'observer_files': len(observer_hashes), 'consumer_files': len(changed)}))


if __name__ == '__main__':
    main()
