"""Repeatable offline replay. Synthetic fixtures never qualify a user's pronunciation."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import re
import sys
import time
import wave

import numpy as np
import psutil

REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / 'apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py'
PHRASES = [
    ('wake', 'Ivy', 'ivy', 'passive'),
    ('wake-request', 'Ivy, open my browser.', 'ivy', 'passive'),
    ('done', 'Done.', 'done', 'listening'),
    ('im-done', "I'm done.", 'done', 'listening'),
    ('clear', 'Clear.', 'clear', 'listening'),
    ('prompt', 'Prompt.', 'prompt', 'listening'),
    ('cancel', 'Prompt cancel.', 'prompt cancel', 'composing'),
    ('reset', 'New session.', 'new session', 'listening'),
    ('reload', 'Reload MCP.', 'reload mcp', 'listening'),
    ('embedded-clear', 'Please clear the table after dinner.', None, 'listening'),
    ('embedded-done', 'When I am done with this work I will call you.', None, 'listening'),
    ('prefix-clear', 'Clear skies are expected tomorrow.', None, 'listening'),
    ('near-wake', 'I think this is interesting.', None, 'passive'),
    ('near-wake-mean', 'I mean the other one.', None, 'passive'),
    ('embedded-wake', 'We should ask Ivy to help with that.', None, 'passive'),
    ('cancel-idle', 'Prompt cancel.', None, 'listening'),
    ('short-clear', 'Clear it.', None, 'listening'),
    ('short-done', 'Done now.', None, 'listening'),
    ('short-prompt', 'Prompt me.', None, 'listening'),
    ('prefix-clear-short', 'A clear statement.', None, 'listening'),
    ('prefix-prompt-short', 'Please prompt.', None, 'listening'),
    ('suffix-reset', 'New session tomorrow.', None, 'listening'),
    ('suffix-reload', 'Reload MCP settings.', None, 'listening'),
    ('long', 'Keep all of these instructions. Open the browser, inspect the current page, '
     'and explain what changed. Take your time and preserve the context of this conversation.', None, 'listening'),
]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def word_errors(reference, hypothesis):
    def words(text):
        return re.findall(r'[a-z0-9]+', text.lower().replace("'", '').replace('’', ''))
    expected, actual = words(reference), words(hypothesis)
    previous = list(range(len(actual) + 1))
    for index, word in enumerate(expected, 1):
        current = [index]
        for offset, candidate in enumerate(actual, 1):
            current.append(min(current[-1] + 1, previous[offset] + 1,
                               previous[offset - 1] + (word != candidate)))
        previous = current
    return {'errors': previous[-1], 'referenceWords': len(expected)}


def pcm(path):
    with wave.open(str(path), 'rb') as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
        rate = wav.getframerate()
        source = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
    return np.interp(np.arange(round(len(source) * 16000 / rate)) * rate / 16000,
                     np.arange(len(source)), source).round().astype(np.int16)


def generate(folder, voice):
    script = '''import contextlib,importlib.util,json,sys
from pathlib import Path
p=Path('D:/Hermes/profiles/ivy/voice/local_worker.py')
s=importlib.util.spec_from_file_location('voice',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with contextlib.redirect_stdout(sys.stderr):
 e=m.Engine()
 for item in json.loads(sys.stdin.read()):
  e.synthesize({'text':item[1],'output':str(Path(sys.argv[1])/(item[0]+'.wav')),'engine':'kokoro','voice':sys.argv[2]})
'''
    subprocess.run(['D:/Hermes/profiles/ivy/voice/.venv/Scripts/python.exe', '-I', '-c',
                    script, str(folder), voice], input=json.dumps(PHRASES), text=True, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-local-engines', action='store_true', required=True)
    parser.add_argument('--generate-synthetic', action='store_true')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--command-paths', type=int, choices=(4, 8, 16), default=8)
    parser.add_argument('--synthetic-voice', choices=('af_heart', 'bf_emma', 'af_bella'), default='af_heart')
    parser.add_argument('--phoneme-wake', action='store_true')
    parser.add_argument('--bpe-wake', action='store_true')
    parser.add_argument('--fixture-kind', choices=('synthetic', 'recorded-human'), default='synthetic')
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.fixtures.mkdir(parents=True, exist_ok=True)
    if args.generate_synthetic:
        if args.fixture_kind != 'synthetic':
            parser.error('Generated fixtures must be labelled synthetic')
        generate(args.fixtures, args.synthetic_voice)
    module = load(WORKER, 'recognition')
    start = time.perf_counter()
    keywords = module.Keywords(command_paths=args.command_paths, phoneme_wake=args.phoneme_wake, bpe_wake=args.bpe_wake)
    kws_cold = (time.perf_counter() - start) * 1000
    process = psutil.Process()
    kws_rss = process.memory_info().rss / 2**20
    time.sleep(2)
    before = sum(process.cpu_times()[:2])
    time.sleep(2)
    kws_idle_cpu = (sum(process.cpu_times()[:2]) - before) / 2 * 100
    start = time.perf_counter()
    stt = module.Transcriber()
    stt_cold = (time.perf_counter() - start) * 1000
    time.sleep(2)
    before = sum(process.cpu_times()[:2])
    time.sleep(2)
    idle_cpu = (sum(process.cpu_times()[:2]) - before) / 2 * 100
    rows = []
    for name, text, expected, mode in PHRASES:
        audio = pcm(args.fixtures / (name + '.wav'))
        for speed in (0.85, 1.0, 1.2):
            data = np.interp(np.arange(0, len(audio), speed), np.arange(len(audio)), audio).round().astype(np.int16)
            active = np.flatnonzero(np.abs(data) >= 262)
            end = int(active[-1]) + 1 if len(active) else 0
            replay = np.concatenate((data, np.zeros(16000, dtype=np.int16)))
            detections = []
            compute = 0
            for index in range(0, len(replay), 640):
                tick = time.perf_counter()
                reply = keywords.run({'stream_id': name + str(speed), 'sequence': index // 640,
                                      'pcm': replay[index:index + 640].tolist(),
                                      'mode': mode, 'threshold': 0.008})
                compute += time.perf_counter() - tick
                if reply['detection']:
                    detections.append({**reply['detection'], 'atAudioMs': (index + 640) / 16,
                                       'endLatencyMs': None if name == 'wake-request' else round((index + 640 - end) / 16)})
            row = {'fixture': name, 'speed': speed, 'expected': expected, 'detections': detections,
                   'kwsComputeMs': round(compute * 1000, 1), 'audioMs': round(len(replay) / 16),
                   'pass': [x['command'] for x in detections] == ([] if expected is None else [expected])}
            if speed == 1:
                start = time.perf_counter()
                result = stt.run({'pcm': data.tolist(), 'sample_rate_hz': 16000})
                row['sttMs'] = round((time.perf_counter() - start) * 1000)
                row['sttWordErrors'] = word_errors(text, result['text'])
                if name == 'wake-request' and detections:
                    tail = data[detections[0]['end_sample']:]
                    following = stt.run({'pcm': tail.tolist(), 'sample_rate_hz': 16000})
                    row['wakeTailWordErrors'] = word_errors('open my browser', following['text'])
                if args.fixture_kind == 'synthetic':
                    row['text'] = result['text']
                if args.baseline:
                    facts = json.loads(Path('D:/Hermes/installs/c6585f5b047045e5/facts.json').read_text())
                    python = Path(facts['packages']['venv']['environment']) / 'Scripts/python.exe'
                    start = time.perf_counter()
                    old = subprocess.run([str(python), '-I', '-u', str(WORKER.with_name('speech_worker.py')), 'transcribe'],
                                         input=json.dumps({'pcm': data.tolist(), 'sample_rate_hz': 16000}) + '\n',
                                         text=True, capture_output=True, timeout=60)
                    row['baselineMs'] = round((time.perf_counter() - start) * 1000)
                    frames = [json.loads(line) for line in old.stdout.splitlines()]
                    transcript = next((frame['text'] for frame in frames if 'text' in frame), None)
                    row['baselineWordErrors'] = None if transcript is None else word_errors(text, transcript)
                    if args.fixture_kind == 'synthetic':
                        row['baselineFrames'] = frames
            rows.append(row)
    evidence = {'synthetic': args.fixture_kind == 'synthetic', 'fixtureKind': args.fixture_kind,
                'microphoneUsed': False, 'llmRequests': 0, 'gpuUsed': False,
                'workerSha256': hashlib.sha256(WORKER.read_bytes()).hexdigest(),
                'commandPaths': args.command_paths, 'syntheticVoice': args.synthetic_voice,
                'phonemeWake': args.phoneme_wake,
                'bpeWake': args.bpe_wake,
                'kwsLoadMs': round(kws_cold), 'sttLoadMs': round(stt_cold),
                'kwsRssMiB': round(kws_rss), 'kwsIdleCpuPercentOneCore': round(kws_idle_cpu, 2),
                'latencyReference': 'Last PCM sample above absolute amplitude 262; wake-request keyword end is unannotated',
                'idleCpuPercentOneCore': round(idle_cpu, 2), 'rssMiB': round(process.memory_info().rss / 2**20),
                'rows': rows, 'unmeasured': ['user pronunciation', 'background media', 'emblem frame stability',
                                           'physical microphone', 'VRAM telemetry']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    if args.fixture_kind == 'synthetic':
        probes = {name: pcm(args.fixtures / (name + '.wav')).tolist() for name in ('wake', 'long')}
        (args.output.parent / 'recognition-probe-input.json').write_text(json.dumps(probes), encoding='utf-8')
    print(json.dumps({'passed': sum(row['pass'] for row in rows), 'total': len(rows),
                      'kwsLoadMs': evidence['kwsLoadMs'], 'sttLoadMs': evidence['sttLoadMs']}))


if __name__ == '__main__':
    main()
