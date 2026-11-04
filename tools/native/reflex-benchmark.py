"""Opt-in inference/resource qualification with installed assets and synthetic silence only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

import psutil


def reader(source, lines):
    for line in source:
        lines.put(line)


def worker(root, mode):
    child = subprocess.Popen(
        [sys.executable, '-I', '-u', str(root / 'apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py'), mode],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    lines = queue.Queue()
    threading.Thread(target=reader, args=(child.stdout, lines), daemon=True).start()
    return child, lines


def request(child, lines, value):
    before = time.perf_counter()
    child.stdin.write(json.dumps(value) + '\n')
    child.stdin.flush()
    result = json.loads(lines.get(timeout=30))
    if 'error' in result:
        raise RuntimeError('Recognition worker: ' + result['error'])
    return (time.perf_counter() - before) * 1000


def percentile(values, fraction):
    import math
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def digest(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-model', action='store_true', required=True)
    parser.add_argument('--layers', choices=['0', '28', '36'], required=True)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--corpus')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    corpus = Path(args.corpus).resolve() if args.corpus else root / 'libs/services/desktop-adapter/fixtures/reflex-evaluation.json'
    identity = {'model_sha256': digest(os.environ['STELLAR_REFLEX_MODEL']), 'llama_sha256': digest(os.environ['STELLAR_REFLEX_LLAMA']),
        'binary_sha256': digest(args.binary), 'corpus_sha256': digest(corpus),
        'prompt_sha256': digest(root / 'apps/stellar-desktop/src-tauri/src/reflex/prompt.rs'),
        'driver_sha256': digest(__file__), 'git_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()}
    children, stop, threads = [], threading.Event(), []
    latencies = {'keywords': [], 'transcribe': []}
    errors = []
    peaks = {'model_rss_bytes': 0, 'recognition_rss_bytes': 0, 'gpu_total_used_mib': 0}
    owned = {}
    try:
        for mode in ('keywords', 'transcribe'):
            child, lines = worker(root, mode)
            children.append(child)
            owned[child.pid] = psutil.Process(child.pid)
            value = {'stream_id': 'reflex-fixture', 'sequence': 0, 'pcm': [0] * 640, 'threshold': 0.01, 'mode': 'passive'} if mode == 'keywords' else {'pcm': [0] * 16000, 'sample_rate_hz': 16000}
            request(child, lines, value)

            def feed(child=child, lines=lines, value=value, mode=mode):
                while not stop.is_set():
                    try:
                        latencies[mode].append(request(child, lines, value))
                        if mode == 'keywords':
                            value['sequence'] += 1
                    except Exception as error:
                        if not stop.is_set(): errors.append(type(error).__name__)
                        return
                    stop.wait(0.04 if mode == 'keywords' else 2)

            thread = threading.Thread(target=feed, daemon=True)
            threads.append(thread)
            thread.start()
        env = {**os.environ, 'STELLAR_REFLEX_GPU_LAYERS': args.layers}
        with (output / 'cases.jsonl').open('w', encoding='utf-8') as result, (output / 'stderr.log').open('w') as error_log:
            benchmark = subprocess.Popen([str(Path(args.binary).resolve()), '--corpus', str(corpus)],
                cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=result, stderr=error_log, creationflags=subprocess.CREATE_NO_WINDOW)
            children.append(benchmark)
            owned[benchmark.pid] = psutil.Process(benchmark.pid)
            started = time.monotonic()
            while benchmark.poll() is None:
                if time.monotonic() - started > 1200:
                    raise TimeoutError('Bounded qualification exceeded twenty minutes')
                try:
                    descendants = owned[benchmark.pid].children(recursive=True)
                    peaks['model_rss_bytes'] = max(peaks['model_rss_bytes'], sum(p.memory_info().rss for p in descendants))
                    workers = {p.pid: p for child in children[:2] if owned[child.pid].is_running() for p in [owned[child.pid], *owned[child.pid].children(recursive=True)]}
                    owned.update(workers)
                    owned.update({p.pid: p for p in descendants})
                    peaks['recognition_rss_bytes'] = max(peaks['recognition_rss_bytes'], sum(p.memory_info().rss for p in workers.values()))
                    gpu = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, creationflags=subprocess.CREATE_NO_WINDOW)
                    if gpu.returncode == 0:
                        peaks['gpu_total_used_mib'] = max(peaks['gpu_total_used_mib'], int(gpu.stdout.splitlines()[0]))
                except (psutil.Error, subprocess.TimeoutExpired):
                    pass
                stop.wait(0.5)
            if benchmark.returncode != 0:
                raise RuntimeError('Qualification failed; inspect stderr.log')
    finally:
        stop.set()
        for child in children:
            if child.stdin:
                try: child.stdin.close()
                except (OSError, ValueError): pass
            try:
                owned.update({p.pid: p for p in owned[child.pid].children(recursive=True)})
            except psutil.Error: pass
        for process in reversed(list(owned.values())):
            try: process.terminate()
            except psutil.NoSuchProcess: pass
            except psutil.Error as error: errors.append(type(error).__name__)
        _, alive = psutil.wait_procs(list(owned.values()), timeout=3)
        for process in alive:
            try: process.kill()
            except psutil.NoSuchProcess: pass
            except psutil.Error as error: errors.append(type(error).__name__)
        _, survivors = psutil.wait_procs(alive, timeout=3)
        if survivors: errors.append('descendant_cleanup_timeout')
        for child in reversed(children):
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: errors.append('cleanup_timeout')
        for thread in threads:
            thread.join(timeout=2)
        evidence = {**identity, **peaks, 'layers': int(args.layers), 'microphone': False, 'desktop_actions': False,
            'recognition_input': 'synthetic silence, not command accuracy qualification', 'worker_errors': errors,
            'recognition_ms': {mode: {'count': len(values), 'p50': percentile(values, .5), 'p95': percentile(values, .95)} for mode, values in latencies.items()}}
        (output / 'resources.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(evidence))


if __name__ == '__main__':
    main()
