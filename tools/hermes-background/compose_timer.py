"""Apply only the sealed six-file timer delta to an immutable export of the old pair."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OLD = Path('D:/Hermes/profiles/ivy/cache/scratch/stellar-339-final-pair-20261113')
BASE_TREE = 'ee377d29789d72934d3da1526cddd4614c409100'
BASE = '5de9a0914f50e3c2acf0ad3968f9cfe7d70cfe96'
CONSUMER = 'e35a74683bf162411510967fe9cc0f09c942fe99'
PATCH = 'c3084051d198b56486eb584fcc73968a125b9925af5b9795435fe22ebd307a1b'
DELTA = 'd827b1814be70b8ded52d31752362a410178d11d55592c5c133994115cbfb378'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def run(args, cwd=ROOT):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True, capture_output=True).stdout


def index(source):
    return {path.decode(): header.decode().split()[1] for item in
        run(['git', 'ls-files', '--stage', '-z'], source).split(b'\0') if item
        for header, path in [item.split(b'\t', 1)]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.absolute()
    scratch = Path('D:/Hermes/profiles/ivy/cache/scratch')
    if (out.parent != scratch or out.exists() or out.is_symlink() or out.is_junction()
            or any(p.is_symlink() or p.is_junction() for p in out.parents)):
        raise ValueError('A fresh direct scratch child without reparse paths is required')
    sealed = ROOT / 'artifacts/issue-339/final-pair-20261113'
    manifest_bytes = (sealed / 'packet-manifest.json').read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != (sealed / 'packet-manifest.sha256').read_text().split()[0]:
        raise ValueError('Old pair seal changed')
    for path, expected in json.loads(manifest_bytes)['files'].items():
        if sha(sealed / path) != expected:
            raise ValueError('Old sealed evidence changed: ' + path)
    source = OLD / 'stellar'
    if run(['git', 'write-tree'], source).decode().strip() != BASE_TREE:
        raise ValueError('Old exact composition index changed')
    expected_tree = index(source)
    for path, oid in expected_tree.items():
        if blob((source / path).read_bytes()) != oid:
            raise ValueError('Old immutable source changed: ' + path)
    incoming = Path('D:/ai-repositories/stellar-issue-299/artifacts/issue-299/reconcile-timer-e35a746-20261113')
    if sha(incoming / 'delta.json') != DELTA or sha(incoming / 'consumer-delta.patch') != PATCH:
        raise ValueError('Sealed timer delta changed')
    delta = json.loads((incoming / 'delta.json').read_text())
    changed = run(['git', 'diff', '--name-only', BASE, CONSUMER]).decode().splitlines()
    if (delta['baseConsumer'] != BASE or delta['consumer'] != CONSUMER or len(changed) != 6
            or set(changed) != {row['path'] for row in delta['files']}):
        raise ValueError('Timer delta is not the complete exact six-file change')
    # Check every old preimage before creating or mutating the new qualification source.
    for row in delta['files']:
        path = source / row['path']
        if row['preimageGitBlob'] is None:
            if path.exists():
                raise ValueError('Expected absent preimage: ' + row['path'])
        elif blob(path.read_bytes()) != row['preimageGitBlob']:
            raise ValueError('Timer preimage mismatch; stop without a half-patch: ' + row['path'])
        post = run(['git', 'show', CONSUMER + ':' + row['path']])
        if blob(post) != row['postimageGitBlob'] or hashlib.sha256(post).hexdigest() != row['postimageSha256']:
            raise ValueError('Timer postimage does not match immutable consumer Git')
    out.mkdir()
    target = out / 'stellar'
    target.mkdir()
    archive = out / 'old-pair.tar'
    run(['git', '-c', 'core.autocrlf=false', 'archive', '--format=tar', '--output=' + str(archive), BASE_TREE], source)
    run(['tar', '-xf', archive, '-C', target])
    shutil.copyfile(incoming / 'consumer-delta.patch', out / 'consumer-delta.patch')
    shutil.copyfile(incoming / 'delta.json', out / 'delta.json')
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', out / 'consumer-delta.patch'], target)
    run(['git', '-c', 'core.autocrlf=false', 'apply', out / 'consumer-delta.patch'], target)
    for row in delta['files']:
        expected_tree[row['path']] = row['postimageGitBlob']
        if sha(target / row['path']) != row['postimageSha256']:
            raise ValueError('Applied timer postimage mismatch: ' + row['path'])
    for path, oid in expected_tree.items():
        if blob((target / path).read_bytes()) != oid:
            raise ValueError('Unexpected assembled source difference: ' + path)
    run(['git', 'init', '--quiet', target])
    run(['git', '-c', 'core.autocrlf=false', 'add', '--all'], target)
    if index(target) != expected_tree:
        raise ValueError('Assembled qualification index differs')
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', out / 'consumer-delta.patch'], target)
    previous = json.loads((sealed / 'composition-config.json').read_text())
    # Reconstruct the whole runtime from immutable Git, not a previously executed scratch tree.
    runtime = out / 'runtime'
    runtime.mkdir()
    runtime_archive = out / 'runtime-base.tar'
    run(['git', '-C', 'D:/Hermes/hermes-agent', '-c', 'core.autocrlf=false', 'archive',
         '--format=tar', '--output=' + str(runtime_archive), previous['runtime_base']])
    run(['tar', '-xf', runtime_archive, '-C', runtime])
    runtime_patch = sealed / 'runtime-candidate/plugin-notification-candidate.patch'
    if sha(runtime_patch) != previous['runtime_patch_sha256']:
        raise ValueError('Sealed runtime candidate changed')
    for row in previous['runtime_postimages']:
        path = runtime / row['path']
        if (row['new'] and path.exists()) or (not row['new'] and sha(path) != row['original_sha256']):
            raise ValueError('Runtime preimage mismatch: ' + row['path'])
    run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', runtime_patch], runtime)
    run(['git', '-c', 'core.autocrlf=false', 'apply', runtime_patch], runtime)
    for row in previous['runtime_postimages']:
        if sha(runtime / row['path']) != row['candidate_sha256']:
            raise ValueError('Runtime postimage mismatch: ' + row['path'])
    shutil.copyfile(target / 'tools/hermes-background/observer_composition_tests.py',
                    runtime / 'tests/gateway/test_observer_notification_composition.py')
    renderer = json.loads((sealed / 'native-report.json').read_text())['current_renderer']
    old_dist = source / 'dist/apps/stellar-desktop/browser'
    dist = target / 'dist/apps/stellar-desktop/browser'
    for path, expected in renderer.items():
        if sha(old_dist / path) != expected:
            raise ValueError('Retained current renderer changed: ' + path)
    shutil.copytree(old_dist, dist)
    fixture = ROOT / 'tools/hermes-background/timer_composition_tests.py'
    shutil.copyfile(fixture, out / 'runtime/tests/gateway/test_timer_stellar_composition.py')
    config = {**previous, 'consumer': CONSUMER, 'previous_consumer': BASE,
        'previous_composition': str(OLD), 'previous_tree': BASE_TREE,
        'source': str(target), 'consumer_source': str(target),
        'observer_source': str(target / 'config/hermes-plugins/stellar-herdr'),
        'timer_patch_sha256': PATCH, 'timer_delta_sha256': DELTA,
        'timer_tree': run(['git', 'write-tree'], target).decode().strip(),
        'fresh_runtime_archive_sha256': sha(runtime_archive),
        'timer_files': delta['files'], 'source_inventory': expected_tree,
        'renderer_unchanged': renderer, 'timer_test_sha256': sha(fixture),
        'timer_composer_sha256': sha(Path(__file__)), 'operational': False}
    (out / 'composition-config.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'out': str(out), 'files_applied_once': 6, 'tree': config['timer_tree']}))


if __name__ == '__main__':
    main()
