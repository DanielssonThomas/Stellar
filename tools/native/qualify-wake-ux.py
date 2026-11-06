"""Opt-in installed CPU engines, synthetic speech replay only; no microphone or provider calls."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    ('ivy', 'Ivy, open my browser.', 'ivy', 'passive'),
    ('hey-ivy', 'Hey Ivy, open my browser.', 'ivy', 'passive'),
    ('hey-ivy-hello', 'Hey Ivy, hello.', 'ivy', 'passive'),
    ('ivy-time', 'Ivy, what time is it?', 'ivy', 'passive'),
    ('dotted', 'I. V., open my browser.', 'ivy', 'passive'),
    ('mean-standard', 'I mean, open my browser.', None, 'passive'),
    ('mean-high', 'I mean, open my browser.', 'ivy', 'passive_sensitive'),
    ('eerie-high', 'Eerie, open my browser.', 'ivy', 'passive_sensitive'),
    ('ive-high', "I've, open my browser.", 'ivy', 'passive_sensitive'),
    ('ambient', 'I think this is interesting.', None, 'passive_sensitive'),
    ('embedded', 'We should ask Ivy to help.', None, 'passive_sensitive'),
    ('embedded-alias', 'The room has an eerie sound.', None, 'passive_sensitive'),
    ('clear-phrase', 'Clear skies are expected tomorrow.', None, 'listening'),
    ('clear-control', 'Clear.', 'clear', 'listening'),
]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generate(folder):
    code = '''import contextlib,importlib.util,json,sys
from pathlib import Path
p=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('voice',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with contextlib.redirect_stdout(sys.stderr):
 e=m.VoiceEngine();e.configure(m.speech_settings())
 for name,text in json.loads(sys.stdin.read()):e.synthesize(text,Path(sys.argv[2])/(name+'.wav'))
'''
    subprocess.run(['D:/Hermes/profiles/ivy/voice/.venv/Scripts/python.exe', '-I', '-c', code,
                    str(ROOT/'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py'), str(folder)],
                   input=json.dumps([(name, text) for name, text, *_ in CASES]), text=True,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-local-engines', action='store_true', required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--generate-synthetic', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--baseline-ref')
    args = parser.parse_args()
    args.fixtures.mkdir(parents=True, exist_ok=True)
    if args.generate_synthetic:
        generate(args.fixtures)
    helper = load(ROOT/'tools/native/benchmark-recognition.py', 'recognition_benchmark')
    source = ROOT/'apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py'
    worker = load(source, 'wake_ux_recognition')
    kws = worker.Keywords()
    baseline = None
    temporary = tempfile.TemporaryDirectory(prefix='stellar-wake-baseline-')
    baseline_sha = None
    if args.baseline_ref:
        baseline_source = subprocess.check_output(['git', 'show', args.baseline_ref+':apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py'], cwd=ROOT)
        baseline_path = Path(temporary.name)/'baseline.py'
        baseline_path.write_bytes(baseline_source)
        baseline_sha = hashlib.sha256(baseline_source).hexdigest()
        baseline = load(baseline_path, 'wake_ux_baseline').Keywords()
    stt = worker.Transcriber()
    results = []
    for name, text, expected, mode in CASES:
        original = helper.pcm(args.fixtures/(name+'.wav'))
        for speed in (0.85, 1.0, 1.2):
            data = np.interp(np.arange(0, len(original), speed), np.arange(len(original)), original).round().astype(np.int16)
            replay = np.concatenate([data, np.zeros(16000, dtype=np.int16)])
            detections = []
            started = time.perf_counter()
            for offset in range(0, len(replay), 640):
                result = kws.run({'stream_id': name+str(speed), 'sequence': offset//640,
                                  'pcm': replay[offset:offset+640].tolist(), 'mode': mode, 'threshold': .008})
                if result['detection']:
                    detections.append(result['detection'])
            row = {'fixture': name, 'fixture_sha256': hashlib.sha256((args.fixtures/(name+'.wav')).read_bytes()).hexdigest(),
                   'mode': mode, 'speed': speed, 'expected': expected,
                   'detections': detections, 'pass': [d['command'] for d in detections] == ([] if expected is None else [expected]),
                   'compute_ms': round((time.perf_counter()-started)*1000)}
            if baseline:
                previous = []
                baseline_started = time.perf_counter()
                for offset in range(0, len(replay), 640):
                    result = baseline.run({'stream_id': name+str(speed), 'sequence': offset//640,
                                           'pcm': replay[offset:offset+640].tolist(),
                                           'mode': 'passive' if mode == 'passive_sensitive' else mode, 'threshold': .008})
                    if result['detection']:
                        previous.append(result['detection'])
                row['baseline_detections'] = previous
                row['baseline_compute_ms'] = round((time.perf_counter()-baseline_started)*1000)
                row['baseline_pass'] = [d['command'] for d in previous] == ([] if expected is None else [expected])
            if speed == 1:
                transcript = stt.run({'pcm': data.tolist(), 'sample_rate_hz': 16000})['text']
                row['synthetic_transcript'] = transcript
                if expected == 'ivy' and detections:
                    tail = data[detections[0]['end_sample']:]
                    if len(tail):
                        following = stt.run({'pcm': tail.tolist(), 'sample_rate_hz': 16000})['text']
                        row['post_wake_transcript'] = following
                        reference = {'hey-ivy-hello': 'hello', 'ivy-time': 'what time is it'}.get(name, 'open my browser')
                        row['post_wake_word_errors'] = helper.word_errors(reference, following)
            results.append(row)
    evidence = {'issue': 308, 'measured_date': '2026-11-07', 'fixture_kind': 'synthetic-af_heart',
                'microphone': False, 'llm_requests': 0, 'worker_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'passed': sum(row['pass'] for row in results), 'total': len(results), 'results': results,
                'baseline_ref': args.baseline_ref, 'baseline_worker_sha256': baseline_sha,
                'baseline_passed': sum(row.get('baseline_pass', False) for row in results) if baseline else None,
                'baseline_mode_mapping': 'passive_sensitive maps to passive because baseline has no high mode',
                'limitations': ['Synthetic CPU replay is not physical microphone or user pronunciation accuracy.',
                                'High sensitivity intentionally treats common utterance-prefix aliases as wake words.',
                                'No background game/music or long-run false-trigger rate was measured.']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2)+'\n', encoding='utf-8')
    temporary.cleanup()
    print(json.dumps({'passed': evidence['passed'], 'total': evidence['total'],
                      'failed': [row['fixture']+':'+str(row['speed']) for row in results if not row['pass']]}))


if __name__ == '__main__':
    main()
