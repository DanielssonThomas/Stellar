"""Export the admitted final producer/consumer pair once into disconnected source copies."""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REPO = Path(__file__).resolve().parents[2]
RUNTIME_BASE = '3b421578588243f920886e6fe79a6faa87ea026e'
PATCH = 'c0a21ab5118d6f7ab23b617e7ea2d2f81d072fa1d9fcd63ba0ba857d8d7356ce'
PRODUCER = 'a0eea43eea9f3b9c33f0678ce9762b2c80000335'
CONSUMER_BASE = 'e216f69d5c5dd2c70276115abea25db1dd1a94e6'
CONSUMER = '5de9a0914f50e3c2acf0ad3968f9cfe7d70cfe96'
SEALED_FRAMES = '821f29b3e84ddbed555f624d7ab2e1300f8ae8e2722b7a8c3faeaba3977e9548'
EARLIER_FRAMES = '88fb3e7019671ea57f7b7ebc529a09077d6dec0fed3bd31f3021b6b38e1f9656'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, cwd=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[:4000])
    return result


def blob(commit, relative):
    result = subprocess.run(['git', 'show', commit + ':' + relative], cwd=REPO, capture_output=True)
    return result.stdout if result.returncode == 0 else None


def shape(value):
    if type(value) is dict:
        return {key: shape(item) for key, item in sorted(value.items())}
    if type(value) is list:
        return [shape(item) for item in value]
    return type(value).__name__


def differences(before, after, prefix=''):
    if type(before) is dict and type(after) is dict:
        result = []
        for key in sorted(before.keys() | after.keys()):
            path = prefix + '/' + key
            if key not in before or key not in after:
                result.append({'path': path, 'before': before.get(key), 'after': after.get(key)})
            else:
                result.extend(differences(before[key], after[key], path))
        return result
    if before != after:
        return [{'path': prefix, 'before': before, 'after': after}]
    return []


def reconcile(seal, earlier, out):
    manifest_bytes = (seal / 'packet-manifest.json').read_bytes()
    expected = (seal / 'packet-manifest.sha256').read_text().split()[0]
    if hashlib.sha256(manifest_bytes).hexdigest() != expected:
        raise ValueError('Producer seal manifest changed')
    manifest = json.loads(manifest_bytes)
    if manifest['checkpoint'] != PRODUCER:
        raise ValueError('Wrong producer checkpoint')
    for relative, expected in manifest['files'].items():
        if digest(seal / relative) != expected:
            raise ValueError('Sealed producer evidence changed: ' + relative)
    old_path, final_path = earlier / 'captured-host-frames.json', seal / 'captured-host-frames.json'
    if digest(old_path) != EARLIER_FRAMES or digest(final_path) != SEALED_FRAMES:
        raise ValueError('Unexpected frame evidence')
    old, final = json.loads(old_path.read_text()), json.loads(final_path.read_text())
    changes, schemas = {}, {}
    keys = ['binding', 'event_id', 'raw_start', 'raw_terminal', 'raw_revoke',
            'canonical_receipt_rpc', 'producer_inspection_rpc']
    for key in keys:
        schemas[key] = shape(old[key]) == shape(final[key])
        changes[key] = differences(old[key], final[key])
    if not all(schemas.values()):
        raise ValueError('Captured wire schema changed; inspect exact evidence before composing')
    source_changes = {}
    for name, previous in old['composition']['observer_hashes'].items():
        relative = 'config/hermes-plugins/stellar-herdr/' + name
        committed = blob(PRODUCER, relative)
        if committed is None:
            raise ValueError('Missing producer source: ' + relative)
        final_hash = final['composition']['observer_hashes'][name]
        if previous != final_hash:
            old_source = earlier / 'observer' / name
            if digest(old_source) != previous:
                raise ValueError('Earlier source changed: ' + name)
            final_source = REPO / relative
            if digest(final_source) != final_hash:
                raise ValueError('Final source snapshot differs: ' + name)
            delta = ''.join(difflib.unified_diff(old_source.read_text().splitlines(True),
                final_source.read_text().splitlines(True), fromfile='earlier/' + name, tofile='final/' + name))
            (out / (name + '.snapshot.diff')).write_text(delta, encoding='utf-8')
            source_changes[name] = {'earlier_sha256': previous, 'final_sha256': final_hash}
    report = {'byte_equal': False, 'earlier_sha256': EARLIER_FRAMES, 'sealed_sha256': SEALED_FRAMES,
        'parsed_schema_equal': schemas, 'exact_value_differences': changes,
        'source_changes': source_changes, 'metadata_differences': differences(old['composition'], final['composition']),
        'meaning': 'Wire shape is unchanged, values and producer exception race fix differ; not byte equality or interchangeability of earlier test evidence.'}
    (out / 'snapshot-reconciliation.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.absolute()
    scratch = Path('D:/Hermes/profiles/ivy/cache/scratch')
    if (out.parent != scratch or out.exists() or out.is_symlink() or out.is_junction()
            or any(parent.is_symlink() or parent.is_junction() for parent in out.parents)):
        raise ValueError('Use a new direct scratch child without reparse paths')
    out.mkdir()
    seal = REPO / 'artifacts/issue-339/observer-forwarding-20261113'
    earlier = scratch / 'stellar-339-observer-qualified-20261113'
    reconcile(seal, earlier, out)
    source = out / 'stellar'
    source.mkdir()
    archive = out / 'producer.tar'
    run(['git', '-c', 'core.autocrlf=false', 'archive', '--format=tar', '--output=' + str(archive), PRODUCER], REPO)
    run(['tar', '-xf', archive, '-C', source])
    changed = run(['git', 'diff', '--name-only', CONSUMER_BASE, CONSUMER], REPO).stdout.decode().splitlines()
    source_manifest = {}
    for relative in changed:
        before, after = blob(CONSUMER_BASE, relative), blob(CONSUMER, relative)
        current = source / relative
        if (before is None and current.exists()) or (before is not None and current.read_bytes() != before):
            raise ValueError('Consumer preimage overlaps producer: ' + relative)
        source_manifest[relative] = {'before_sha256': hashlib.sha256(before).hexdigest() if before is not None else None,
                                   'after_sha256': hashlib.sha256(after).hexdigest() if after is not None else None}
    patch = out / 'consumer-e216-to-5de9.patch'
    patch.write_bytes(run(['git', 'diff', '--binary', '--full-index', CONSUMER_BASE, CONSUMER], REPO).stdout)
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', patch], source)
    run(['git', '-c', 'core.autocrlf=false', 'apply', patch], source)
    for relative in changed:
        after = blob(CONSUMER, relative)
        if after is None or (source / relative).read_bytes() != after:
            raise ValueError('Consumer postimage differs: ' + relative)
    # An inverse preimage check proves the exact delta is present once; never apply another overlapping export.
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', patch], source)
    candidate = seal / 'runtime-candidate'
    if digest(candidate / 'plugin-notification-candidate.patch') != PATCH:
        raise ValueError('Runtime candidate changed')
    runtime = out / 'runtime'
    runtime.mkdir()
    runtime_archive = out / 'runtime.tar'
    run(['git', '-C', 'D:/Hermes/hermes-agent', '-c', 'core.autocrlf=false', 'archive',
         '--format=tar', '--output=' + str(runtime_archive), RUNTIME_BASE])
    run(['tar', '-xf', runtime_archive, '-C', runtime])
    runtime_manifest = json.loads((candidate / 'source-manifest.json').read_text())
    for row in runtime_manifest['files']:
        path = runtime / row['path']
        if (row['new'] and path.exists()) or (not row['new'] and digest(path) != row['original_sha256']):
            raise ValueError('Runtime preimage differs: ' + row['path'])
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', candidate / 'plugin-notification-candidate.patch'], runtime)
    run(['git', '-c', 'core.autocrlf=false', 'apply', candidate / 'plugin-notification-candidate.patch'], runtime)
    for row in runtime_manifest['files']:
        if digest(runtime / row['path']) != row['candidate_sha256']:
            raise ValueError('Runtime postimage differs: ' + row['path'])
    old_test = 'tools/hermes-background/observer_composition_tests.py'
    shutil.copyfile(source / old_test, runtime / 'tests/gateway/test_observer_notification_composition.py')
    new_test = REPO / 'tools/hermes-background/final_composition_tests.py'
    shutil.copyfile(new_test, runtime / 'tests/gateway/test_final_stellar_composition.py')
    observer = source / 'config/hermes-plugins/stellar-herdr'
    config = {'producer': PRODUCER, 'stellar_base': PRODUCER, 'consumer_base': CONSUMER_BASE, 'consumer': CONSUMER,
        'runtime_base': RUNTIME_BASE, 'runtime_patch_sha256': PATCH, 'runtime_postimages': runtime_manifest['files'],
        'source': str(source), 'observer_source': str(observer), 'consumer_source': str(source),
        'observer_hashes': {p.name: digest(p) for p in observer.iterdir() if p.suffix == '.py' or p.name == 'plugin.yaml'},
        'consumer_pre_postimages': source_manifest, 'consumer_patch_sha256': digest(patch),
        'producer_archive_sha256': digest(archive), 'runtime_archive_sha256': digest(runtime_archive),
        'composer_sha256': digest(Path(__file__)), 'composition_test_sha256': digest(new_test),
        'original_composition_test_sha256': digest(source / old_test), 'operational': False}
    (out / 'composition-config.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'out': str(out), 'consumer_paths_applied_once': len(changed), 'producer': PRODUCER, 'consumer': CONSUMER}))


if __name__ == '__main__':
    main()
