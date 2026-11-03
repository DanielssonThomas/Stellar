"""Offline warm-cache comparator; run with the existing Hermes STT interpreter."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import time


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-local-engine', action='store_true', required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    worker = load(root / 'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py', 'legacy_worker')
    # Import only after the worker sets offline/CPU environment policy.
    import faster_whisper
    harness = load(Path(__file__).with_name('benchmark-recognition.py'), 'replay')
    original = faster_whisper.WhisperModel
    cached = None
    load_ms = None

    def model(*values, **options):
        nonlocal cached, load_ms
        if cached is None:
            start = time.perf_counter()
            cached = original(*values, **options)
            load_ms = round((time.perf_counter() - start) * 1000, 1)
        return cached

    faster_whisper.WhisperModel = model
    rows = []
    for voice in ('af_heart', 'bf_emma'):
        folder = args.fixtures if voice == 'af_heart' else args.fixtures.with_name(args.fixtures.name + '-emma')
        for name, reference, _expected, _mode in harness.PHRASES:
            audio = harness.pcm(folder / (name + '.wav')).tolist()
            reply = io.BytesIO()
            start = time.perf_counter()
            worker.transcribe({'pcm': audio, 'sample_rate_hz': 16000}, reply)
            duration = round((time.perf_counter() - start) * 1000, 1)
            frames = [json.loads(line) for line in reply.getvalue().splitlines()]
            text = next(frame['text'] for frame in frames if 'text' in frame)
            rows.append({'voice': voice, 'fixture': name, 'ms': duration,
                         'wordErrors': harness.word_errors(reference, text),
                         'coldModel': len(rows) == 0})
    args.output.write_text(json.dumps({'synthetic': True, 'microphoneUsed': False,
        'llmRequests': 0, 'gpuUsed': False, 'modelLoadMs': load_ms,
        'rssMiB': round(harness.psutil.Process().memory_info().rss / 2**20, 1),
        'workerSha256Lf': hashlib.sha256((root / 'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py').read_bytes().replace(b'\r\n', b'\n')).hexdigest(),
        'scope': 'Existing worker/configuration with one cached Whisper Base CPU INT8 model; no process/IPC cost',
        'rows': rows}, indent=2), encoding='utf-8')
    print('Warm Whisper comparator completed; results omit transcript contents.')


if __name__ == '__main__':
    main()
