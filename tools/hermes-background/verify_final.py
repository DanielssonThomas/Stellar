"""Consume this composition's real host capture through current consumer/native/renderer fixtures."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

PRODUCER = 'a0eea43eea9f3b9c33f0678ce9762b2c80000335'
CONSUMER = '5de9a0914f50e3c2acf0ad3968f9cfe7d70cfe96'
CONSUMER_BASE = 'e216f69d5c5dd2c70276115abea25db1dd1a94e6'
REPO = Path(__file__).resolve().parents[2]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inventory(commit):
    raw = subprocess.run(['git', 'ls-tree', '-rz', commit], cwd=REPO, check=True, capture_output=True).stdout
    return {path.decode(): header.decode().split()[2] for row in raw.split(b'\0') if row
            for header, path in [row.split(b'\t', 1)]}


def require_complete_consumer(config):
    changed = subprocess.run(['git', 'diff', '--name-only', CONSUMER_BASE, CONSUMER],
        cwd=REPO, check=True, capture_output=True).stdout.decode().splitlines()
    if config.get('consumer_base') != CONSUMER_BASE or set(config['consumer_pre_postimages']) != set(changed):
        raise ValueError('Consumer manifest is not the complete immutable e216-to-5de9 delta')


def require_native_evidence(out, native):
    for name in ['projected-frames.json', 'native-snapshot.json']:
        if sha((out / name).read_bytes()) != native.get(name + '_sha256'):
            raise ValueError('Native evidence changed or stale: ' + name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--composition', type=Path, required=True)
    parser.add_argument('--phase', choices=['native', 'frontend'], required=True)
    args = parser.parse_args()
    out = args.composition.resolve()
    config = json.loads((out / 'composition-config.json').read_text())
    if config['producer'] != PRODUCER or config['consumer'] != CONSUMER or config['operational'] is not False:
        raise ValueError('Expected exact disconnected final pair')
    require_complete_consumer(config)
    source = out / 'stellar'
    expected = inventory(PRODUCER)
    consumer_tree = inventory(CONSUMER)
    for relative in config['consumer_pre_postimages']:
        expected[relative] = consumer_tree[relative]

    def check_source():
        result = {}
        for relative, oid in expected.items():
            data = (source / relative).read_bytes()
            if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != oid:
                raise ValueError('Composed immutable source changed: ' + relative)
            result[relative] = sha(data)
        return result

    before = check_source()
    # The unchanged AST size gate enumerates Git. This is qualification metadata,
    # not an issue worktree, alternate claim, development branch or published commit.
    if not (source / '.git').exists():
        subprocess.run(['git', 'init', '--quiet', str(source)], check=True, capture_output=True)
        subprocess.run(['git', '-c', 'core.autocrlf=false', 'add', '--all'], cwd=source, check=True, capture_output=True)
    indexed = subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=source, check=True, capture_output=True).stdout
    index = {path.decode(): header.decode().split()[1] for row in indexed.split(b'\0') if row
             for header, path in [row.split(b'\t', 1)]}
    if index != expected:
        raise ValueError('Disposable Git index does not exactly match the immutable composed source')
    frame = out / 'captured-host-frames.json'
    capture = json.loads(frame.read_text())
    if capture.get('fixture') is not True or capture['composition'] != config:
        raise ValueError('Require this exact fresh composition host capture')
    dist = source / 'dist/apps/stellar-desktop/browser'
    if not (dist / 'index.html').is_file():
        raise ValueError('Build CURRENT renderer before native/consumer verification')
    renderer = {str(p.relative_to(dist)): sha(p.read_bytes()) for p in sorted(dist.rglob('*')) if p.is_file()}
    env = dict(os.environ)
    env.pop('MSYS_NO_PATHCONV', None)
    env.pop('MSYS2_ARG_CONV_EXCL', None)
    env.update({'NX_DAEMON': 'false', 'CARGO_NET_OFFLINE': 'true', 'RUST_TEST_THREADS': '2',
                'CARGO_TARGET_DIR': str(REPO / 'target'),
                'STELLAR_PLUGIN_FRAME_FIXTURE': str(out / 'projected-frames.json'),
                'STELLAR_PLUGIN_SNAPSHOT_FIXTURE': str(out / 'native-snapshot.json')})
    cargo_home = Path(env.get('CARGO_HOME') or 'D:/stellar-temp/stellar-249-toolchain/cargo')
    rustup_home = Path(env.get('RUSTUP_HOME') or 'D:/stellar-temp/stellar-249-toolchain/rustup')
    if not (cargo_home / 'bin/cargo.exe').is_file() or not (
            rustup_home / 'toolchains/1.99.1-x86_64-pc-windows-msvc/bin/rustc.exe').is_file():
        raise ValueError('Existing pinned Rust1.99.1 toolchain unavailable; no installation authorized')
    env['CARGO_HOME'], env['RUSTUP_HOME'] = str(cargo_home), str(rustup_home)
    env['PATH'] = os.pathsep.join([str(Path(sys.executable).parent), str(cargo_home / 'bin'), env.get('PATH', '')])
    # Only compile/test caches are shared with the owning producer; neither owning source tree is overlaid.
    report = {'fixtureOnly': True, 'liveOperation': False, 'phase': args.phase,
        'composition_config_sha256': sha((out / 'composition-config.json').read_bytes()),
        'verifier_sha256': sha(Path(__file__).read_bytes()), 'raw_frames_sha256': sha(frame.read_bytes()),
        'source_files': len(before), 'source_tree_sha256': sha(json.dumps(before, sort_keys=True).encode()),
        'current_renderer': renderer, 'checks': [], 'passed': False}
    report['disposable_git_tree'] = subprocess.run(['git', 'write-tree'], cwd=source,
        check=True, capture_output=True).stdout.decode().strip()
    report['process_toolchain'] = {'cargo_home': str(cargo_home), 'rustup_home': str(rustup_home),
                                   'python': sys.executable, 'rust_test_threads': 2, 'install': False}
    path = out / (args.phase + '-report.json')

    def run(name, command):
        log = out / (args.phase + '-' + name + '.log')
        start = time.monotonic()
        executable = shutil.which(str(command[0]), path=env['PATH'])
        if executable is None:
            raise ValueError('Missing required executable: ' + str(command[0]))
        resolved = [executable, *[str(arg) for arg in command[1:]]]
        with log.open('wb') as stream:
            result = subprocess.run(resolved, cwd=source, env=env,
                                    stdout=stream, stderr=subprocess.STDOUT)
        report['checks'].append({'name': name, 'command': [str(arg) for arg in command],
            'resolved_command': resolved, 'cwd': str(source), 'status': result.returncode, 'seconds': round(time.monotonic() - start, 2),
            'log_sha256': sha(log.read_bytes())})
        path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(name + ': ' + str(result.returncode), flush=True)
        if result.returncode:
            raise RuntimeError('Failed check: ' + str(log))

    try:
        if args.phase == 'native':
            run('projection', [sys.executable, '-B', 'tools/native/fixtures/plugin_notification_projection.py',
                               frame, out / 'projected-frames.json'])
            projected = json.loads((out / 'projected-frames.json').read_text())
            if projected['producer_inspection_rpc'] != capture['producer_inspection_rpc']:
                raise ValueError('Consumer projection changed canonical inspection evidence')
            run('python', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tools/native', '-p', 'ivy*test.py', '-q'])
            run('format', ['cargo', 'fmt', '--all', '--', '--check'])
            run('tests', ['cargo', 'test', '--offline', '--locked', '--workspace'])
            run('clippy', ['cargo', 'clippy', '--offline', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings'])
            run('smoke-clippy', ['cargo', 'clippy', '--offline', '--locked', '-p', 'stellar-desktop', '--all-targets',
                                 '--features', 'native-smoke', '--', '-D', 'warnings'])
            run('build', ['cargo', 'build', '--offline', '--locked', '-p', 'stellar-desktop', '--features', 'custom-protocol'])
            run('size', ['cargo', 'run', '--offline', '--locked', '--quiet', '-p', 'stellar-rust-size', '--', source])
            run('bindings', ['node', 'tools/native/cargo.mjs', 'contract-check'])
            for name in ['projected-frames.json', 'native-snapshot.json']:
                report[name + '_sha256'] = sha((out / name).read_bytes())
            executable = REPO / 'target/debug/stellar-desktop.exe'
            report['current_native_executable_sha256'] = sha(executable.read_bytes())
        else:
            native = json.loads((out / 'native-report.json').read_text())
            if native.get('passed') is not True or native['raw_frames_sha256'] != sha(frame.read_bytes()):
                raise ValueError('Require successful native consumption of this exact host capture')
            if native['current_renderer'] != renderer:
                raise ValueError('Current renderer changed between native build and browser test')
            require_native_evidence(out, native)
            run('units-lint', ['cmd.exe', '/d', '/c', 'corepack', 'pnpm', 'exec', 'nx', 'run-many',
                '-t', 'test,lint', '-p', 'service-desktop-adapter,desktop-contracts,stellar-desktop', '--skip-nx-cache'])
            env['STELLAR_DESKTOP_E2E_PORT'] = '4397'
            env['STELLAR_FINAL_COMPOSITION_ROOT'] = str(source)
            env['CI'] = 'true'
            renderer_config = REPO / 'tools/hermes-background/final-renderer.config.mjs'
            report['renderer_test_config_sha256'] = sha(renderer_config.read_bytes())
            run('renderer', ['cmd.exe', '/d', '/c', 'corepack', 'pnpm', 'exec', 'playwright', 'test',
                '--config=' + str(renderer_config), 'background-updates.spec.ts',
                '--project=chromium', '--workers=1', '--retries=0'])
            require_native_evidence(out, native)
            report['native_evidence_hashes_verified_before_after'] = True
            report['native_report_sha256'] = sha((out / 'native-report.json').read_bytes())
        if check_source() != before:
            raise ValueError('Source tree changed while checks ran')
        after_renderer = {str(p.relative_to(dist)): sha(p.read_bytes()) for p in sorted(dist.rglob('*')) if p.is_file()}
        if after_renderer != renderer:
            raise ValueError('Embedded renderer changed during checks')
        report['source_unchanged'] = True
        report['renderer_unchanged'] = True
        report['passed'] = True
    except BaseException as error:
        report['failure'] = str(error)
        raise
    finally:
        path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
