"""Offline command replay with miss-inclusive counts; no application/UI claims."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import statistics
import time

import numpy as np


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summary(rows):
    groups = {}
    for row in rows:
        command = row['expected'] or 'negative'
        group = groups.setdefault(command, {'trials': 0, 'correct': 0, 'misses': 0,
                                           'falseActivations': 0, 'latencies': []})
        group['trials'] += 1
        actual = [event['command'] for event in row['detections']]
        correct = actual == ([row['expected']] if row['expected'] else [])
        group['correct'] += int(correct)
        group['misses'] += int(row['expected'] is not None and row['expected'] not in actual)
        group['falseActivations'] += sum(command != row['expected'] for command in actual)
        if row['expected'] is not None:
            group['falseActivations'] += max(0, actual.count(row['expected']) - 1)
        if row['expected'] is not None:
            latency = row['detections'][0]['endLatencyProxyMs'] if correct and row['detections'] else None
            group['latencies'].append(latency)
    for group in groups.values():
        values = group.pop('latencies')
        valid = [value for value in values if value is not None and value >= 0]
        group['recall'] = group['correct'] / group['trials']
        group['latencyEligibleTrials'] = len(values)
        group['unmeasuredOrMissedLatencies'] = len(values) - len(valid)
        group['successfulProxyMedianMs'] = statistics.median(valid) if valid else None
        # Misses remain in the denominator. Unknown timing never counts as within target.
        group['proxyWithinDeadline'] = {str(limit): sum(0 <= value <= limit for value in valid)
                                        for limit in (250, 500, 1000)}
        group['missInclusiveProxyP95Ms'] = (sorted(valid)[min(len(valid)-1, int(len(values)*.95))]
                                           if valid and len(valid) > int(len(values)*.95) else None)
    return groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-local-engines', action='store_true', required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--legacy', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--threshold', type=float, default=.008)
    parser.add_argument('--silence-ms', type=int, choices=(240, 600, 800))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    source = root / 'apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py'
    worker = load(source, 'recognition_worker')
    harness = load(Path(__file__).with_name('benchmark-recognition.py'), 'legacy_harness')
    if args.legacy:
        kind = 'synthetic'
        trials = [{'id': f'{voice}-{name}-{speed}', 'file': str(folder / (name+'.wav')),
                   'text': text, 'expected': expected, 'mode': mode, 'voice': voice, 'resample': speed}
                  for voice, folder in [('af_heart', args.fixtures/'recognition-fixtures'),
                                        ('bf_emma', args.fixtures/'recognition-fixtures-emma')]
                  for name, text, expected, mode in harness.PHRASES for speed in (.85, 1, 1.2)]
    else:
        manifest = json.loads((args.fixtures / 'manifest.json').read_text(encoding='utf-8'))
        kind = manifest['fixtureKind']
        trials = [{**trial, 'file': str(args.fixtures / (trial['id']+'.wav'))}
                  for trial in manifest['trials']]
    engine = worker.Keywords()
    if args.silence_ms:
        engine.command_silence = args.silence_ms * 16
    rows = []
    for trial in trials:
        path = Path(trial['file'])
        audio = harness.pcm(path)
        speed = trial.get('resample', 1)
        if speed != 1:
            audio = np.interp(np.arange(0, len(audio), speed), np.arange(len(audio)), audio).round().astype(np.int16)
        active = np.flatnonzero(abs(audio.astype(np.int32)) >= 262)
        end = (int(active[-1])+1)/16 if len(active) else 0
        # User clips contain clicks/noise after speech. Their phrase ends are not annotated.
        timing = kind == 'synthetic' and 'wake-request' not in trial['id']
        replay = np.concatenate([audio, np.zeros(16000, dtype=np.int16)])
        detections = []
        start = time.perf_counter()
        for at in range(0, len(replay), 640):
            result = engine.run({'stream_id': trial['id'], 'sequence': at//640,
                                 'pcm': replay[at:at+640].tolist(), 'mode': trial['mode'],
                                 'threshold': args.threshold})
            if result['detection']:
                detections.append({**result['detection'], 'atAudioMs': (at+640)/16,
                                   'endLatencyProxyMs': round((at+640)/16-end, 1) if timing else None})
        rows.append({'id': trial['id'], 'expected': trial['expected'], 'mode': trial['mode'],
                     'variant': trial['id'].split('-', 2)[-1] if 'voice' in trial else trial['id'],
                     'voice': trial.get('voice', 'user'), 'condition': trial.get('condition', kind),
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'detections': detections,
                     'audioMs': len(audio)/16, 'computeMs': round((time.perf_counter()-start)*1000, 2),
                     'fallback': 'passive: no STT by design' if trial['mode'] == 'passive'
                     else 'not exercised: keyword replay does not prove VAD/assembler/STT routing'})
    evidence = {'fixtureKind': kind, 'role': 'calibration/stress, not held-out acceptance',
                'workerSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'threshold': args.threshold, 'commandSilenceMs': engine.command_silence/16,
                'timing': 'Synthetic last absolute PCM >=262 proxy only; human and wake-request ends unannotated',
                'scope': 'CPU keyword engine; excludes capture, native IPC, application scheduling and fallback',
                'summary': summary(rows),
                'variants': {variant: summary([row for row in rows if row['variant'] == variant])
                             for variant in sorted({row['variant'] for row in rows if row['expected']})},
                'rows': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps(evidence['summary']), flush=True)


if __name__ == '__main__':
    main()
