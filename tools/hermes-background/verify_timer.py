"""Qualify only timer/embed affected boundaries and retain a versioned unlaunched binary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PRODUCER = 'a0eea43eea9f3b9c33f0678ce9762b2c80000335'
CONSUMER = 'e35a74683bf162411510967fe9cc0f09c942fe99'
BASE = '5de9a0914f50e3c2acf0ad3968f9cfe7d70cfe96'
PATCH = 'c3084051d198b56486eb584fcc73968a125b9925af5b9795435fe22ebd307a1b'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout


def inventory(commit):
    return {path.decode(): header.decode().split()[2] for row in git('ls-tree', '-rz', commit).split(b'\0') if row
            for header, path in [row.split(b'\t', 1)]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--composition', type=Path, required=True)
    args = parser.parse_args()
    out = args.composition.resolve()
    config = json.loads((out / 'composition-config.json').read_text())
    if config['consumer'] != CONSUMER or config['previous_consumer'] != BASE or config['timer_patch_sha256'] != PATCH:
        raise ValueError('Expected exact sealed timer version tuple')
    expected = inventory(PRODUCER)
    consumer = inventory(CONSUMER)
    for relative in git('diff', '--name-only', 'e216f69d5c5dd2c70276115abea25db1dd1a94e6', CONSUMER).decode().splitlines():
        expected[relative] = consumer[relative]
    if config['source_inventory'] != expected:
        raise ValueError('Incomplete assembled consumer/source inventory')
    source = out / 'stellar'

    def verify_source():
        for relative, oid in expected.items():
            data = (source / relative).read_bytes()
            if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != oid:
                raise ValueError('Assembled source changed: ' + relative)

    verify_source()
    dist = source / 'dist/apps/stellar-desktop/browser'
    renderer = {str(p.relative_to(dist)): sha(p.read_bytes()) for p in dist.rglob('*') if p.is_file()}
    if renderer != config['renderer_unchanged']:
        raise ValueError('Current renderer does not match unchanged qualified assets')
    capture = out / 'timer-host-consumer-frames.json'
    proof = json.loads(capture.read_text())
    if proof.get('actual_timer_to_authenticated_producer') is not True or proof['composition'] != config:
        raise ValueError('Require fresh assembled timer -> actual producer capture')
    if sha((ROOT / 'tools/hermes-background/timer_composition_tests.py').read_bytes()) != config['timer_test_sha256']:
        raise ValueError('Executed timer fixture source changed')
    if sha((out / 'runtime/tests/gateway/test_timer_stellar_composition.py').read_bytes()) != config['timer_test_sha256']:
        raise ValueError('Copied executed timer fixture does not match its pinned source')
    env = dict(os.environ)
    cargo = Path('D:/stellar-temp/stellar-249-toolchain/cargo')
    rustup = Path('D:/stellar-temp/stellar-249-toolchain/rustup')
    if not (cargo / 'bin/cargo.exe').is_file() or not (rustup / 'toolchains/1.99.1-x86_64-pc-windows-msvc/bin/rustc.exe').is_file():
        raise ValueError('Previously qualified Rust1.99.1 unavailable; no install authorized')
    env.update({'CARGO_HOME': str(cargo), 'RUSTUP_HOME': str(rustup), 'CARGO_NET_OFFLINE': 'true',
        'CARGO_TARGET_DIR': str(ROOT / 'target'), 'RUST_TEST_THREADS': '2',
        'STELLAR_PLUGIN_FRAME_FIXTURE': str(capture),
        'STELLAR_PLUGIN_SNAPSHOT_FIXTURE': str(out / 'native-timer-snapshot.json')})
    env['PATH'] = os.pathsep.join([str(Path(sys.executable).parent), str(cargo / 'bin'), env.get('PATH', '')])
    report = {'fixtureOnly': True, 'installed': False, 'launched': False, 'live': False,
        'producer': PRODUCER, 'consumer': CONSUMER, 'base_consumer': BASE,
        'runtime_base': config['runtime_base'], 'runtime_patch_sha256': config['runtime_patch_sha256'],
        'timer_patch_sha256': PATCH, 'tree': config['timer_tree'], 'source_files': len(expected),
        'config_sha256': sha((out / 'composition-config.json').read_bytes()),
        'verifier_sha256': sha(Path(__file__).read_bytes()), 'capture_sha256': sha(capture.read_bytes()),
        'renderer_assets': renderer, 'checks': [], 'passed': False}
    record = out / 'timer-report.json'

    def run(name, args):
        executable = shutil.which(str(args[0]), path=env['PATH'])
        if executable is None:
            raise ValueError('Required executable unavailable: ' + str(args[0]))
        command = [executable, *map(str, args[1:])]
        log = out / (name + '.log')
        start = time.monotonic()
        with log.open('wb') as output:
            result = subprocess.run(command, cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT)
        report['checks'].append({'name': name, 'command': command, 'cwd': str(source), 'status': result.returncode,
            'seconds': round(time.monotonic() - start, 2), 'log_sha256': sha(log.read_bytes())})
        record.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(name + ': ' + str(result.returncode), flush=True)
        if result.returncode:
            raise RuntimeError('Failed affected check: ' + str(log))

    try:
        run('focused-timer-embed', [sys.executable, '-B', '-m', 'unittest', 'tools.native.ivy_reconcile_test', '-v'])
        run('native-config', ['node', '--test', 'tools/native/config.spec.mjs'])
        run('format', ['cargo', 'fmt', '--all', '--', '--check'])
        run('native-consumer-path', ['cargo', 'test', '--offline', '--locked', '-p', 'stellar-desktop',
                                    '--bin', 'stellar-desktop', 'ivy::plugin_notification_tests::'])
        run('clippy', ['cargo', 'clippy', '--offline', '--locked', '-p', 'stellar-desktop', '--all-targets', '--', '-D', 'warnings'])
        run('smoke-clippy', ['cargo', 'clippy', '--offline', '--locked', '-p', 'stellar-desktop', '--all-targets',
                             '--features', 'native-smoke', '--', '-D', 'warnings'])
        run('native-build', ['cargo', 'build', '--offline', '--locked', '-p', 'stellar-desktop', '--features', 'custom-protocol'])
        run('size', ['cargo', 'run', '--offline', '--locked', '--quiet', '-p', 'stellar-rust-size', '--', source])
        binary = ROOT / 'target/debug/stellar-desktop.exe'
        contents = binary.read_bytes()
        for name in ['ivy_reconcile.py', 'ivy_bridge.py']:
            module = (source / 'apps/stellar-desktop/src-tauri/src/ivy' / name).read_bytes()
            if module not in contents:
                raise ValueError('New native executable lacks exact assembled embedded module: ' + name)
        old_binary = ROOT / 'artifacts/issue-339/final-pair-20261113/portable/stellar-desktop-a0eea43-5de9a09.exe'
        timer = (source / 'apps/stellar-desktop/src-tauri/src/ivy/ivy_reconcile.py').read_bytes()
        if timer in old_binary.read_bytes():
            raise ValueError('Old binary unexpectedly contains timer; baseline provenance mismatch')
        destination = out / 'portable/stellar-desktop-a0eea43-e35a746.exe'
        destination.parent.mkdir()
        shutil.copyfile(binary, destination)
        report['binary'] = str(destination)
        report['binary_sha256'] = sha(contents)
        report['old_binary_sha256'] = sha(old_binary.read_bytes())
        report['embedded_timer_sha256'] = sha(timer)
        report['native_snapshot_sha256'] = sha((out / 'native-timer-snapshot.json').read_bytes())
        verify_source()
        if renderer != {str(p.relative_to(dist)): sha(p.read_bytes()) for p in dist.rglob('*') if p.is_file()}:
            raise ValueError('Renderer changed during native embedding/build')
        if sha(capture.read_bytes()) != report['capture_sha256']:
            raise ValueError('Timer capture changed during native consumption')
        report['source_renderer_capture_unchanged'] = True
        report['passed'] = True
    except BaseException as error:
        report['failure'] = str(error)
        raise
    finally:
        record.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
