"""Repeatable Windows CPU-only synthetic TTS comparison. Never calls an LLM or plays sound."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCE = 'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py'
TEXT = 'I can help with that. Let us work through the next steps together.'
WRAPPER = r'''
import ctypes,importlib.util,json,sys,time,types
from ctypes import wintypes
spec=importlib.util.spec_from_file_location('speech',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
sys.modules['winsound']=types.SimpleNamespace(PlaySound=lambda *a:None,SND_FILENAME=0x20000,SND_NODEFAULT=2)
class Memory(ctypes.Structure):
 _fields_=[('cb',wintypes.DWORD),('faults',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in ['peak','working','pagedpeak','paged','nonpagedpeak','nonpaged','pagefile','pagefilepeak']]
memory=Memory();memory.cb=ctypes.sizeof(memory)
query=ctypes.WinDLL('psapi').GetProcessMemoryInfo
query.argtypes=[wintypes.HANDLE,ctypes.POINTER(Memory),wintypes.DWORD]
original=w.speak
count=0
target=int(sys.argv[2])
def speak(req,protocol,engine=None):
 global count
 if hasattr(w,'VoiceEngine'):original(req,protocol,engine)
 else:original(req,protocol)
 count+=1
 cpu=time.process_time();before=time.perf_counter();time.sleep(0.25)
 idle_cpu=(time.process_time()-cpu)/(time.perf_counter()-before)*100
 steady=None
 if target>1 and count==target:
  time.sleep(1);cpu=time.process_time();before=time.perf_counter();time.sleep(3)
  steady=round((time.process_time()-cpu)/(time.perf_counter()-before)*100,3)
 if not query(wintypes.HANDLE(-1),ctypes.byref(memory),memory.cb):raise OSError('memory query failed')
 w.emit(protocol,{'benchmark':{'working_set_bytes':memory.working,'peak_working_set_bytes':memory.peak,'idle_cpu_percent_one_core':round(idle_cpu,3),'steady_idle_cpu_percent_one_core':steady}})
w.speak=speak
sys.argv=['speech','speak'];w.main()
'''


def percentile(values, fraction):
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


def run(source, directory, count):
    launch = time.perf_counter()
    process = subprocess.Popen([
        'D:/Hermes/profiles/ivy/voice/.venv/Scripts/python.exe', '-I', '-u', '-c', WRAPPER, str(source), str(count)
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW)
    results = []
    try:
        for index in range(count):
            folder = directory / str(index)
            folder.mkdir()
            started = launch if index == 0 else time.perf_counter()
            timer = threading.Timer(60, process.kill)
            timer.start()
            try:
                process.stdin.write((json.dumps({'text': TEXT, 'output': str(folder/'reply.wav')})+'\n').encode())
                process.stdin.flush()
                result = {'worker_timings': []}
                while True:
                    line = process.stdout.readline(16385)
                    if not line or len(line) > 16384:
                        raise RuntimeError('worker ended or exceeded protocol bound')
                    frame = json.loads(line)
                    if 'error' in frame:
                        raise RuntimeError('worker failed: ' + frame['error'])
                    if 'timing' in frame:
                        result['worker_timings'].append(frame['timing'])
                    if frame.get('state') == 'speaking':
                        result['first_playable_audio_ms'] = round((time.perf_counter()-started)*1000, 2)
                    if frame.get('done') is True:
                        result['complete_ms'] = round((time.perf_counter()-started)*1000, 2)
                    if 'benchmark' in frame:
                        result.update(frame['benchmark'])
                        break
                results.append(result)
            finally:
                timer.cancel()
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()
    return results


def summarize(runs):
    values = [row['first_playable_audio_ms'] for row in runs]
    return {'samples': len(runs), 'p50_first_playable_audio_ms': statistics.median(values),
            'p95_first_playable_audio_ms': percentile(values, .95),
            'p50_working_set_bytes': statistics.median(row['working_set_bytes'] for row in runs),
            'steady_idle_cpu_percent_one_core': runs[-1].get('steady_idle_cpu_percent_one_core'),
            'max_idle_cpu_percent_one_core': max(row['idle_cpu_percent_one_core'] for row in runs), 'runs': runs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', required=True)
    parser.add_argument('--samples', type=int, default=12)
    parser.add_argument('--output', type=Path, default=ROOT/'artifacts/native/response-latency.json')
    args = parser.parse_args()
    if not 5 <= args.samples <= 100:
        parser.error('--samples must be 5..100')
    baseline = subprocess.check_output(['git', 'show', f'{args.baseline_ref}:{SOURCE}'], cwd=ROOT)
    current = (ROOT/SOURCE).read_bytes()
    with tempfile.TemporaryDirectory(prefix='stellar-response-latency-') as tmp:
        directory = Path(tmp)
        old = directory/'baseline.py';old.write_bytes(baseline)
        baseline_runs = []
        cold_runs = []
        for index in range(args.samples):
            for name, source, target in [('baseline', old, baseline_runs), ('cold', ROOT/SOURCE, cold_runs)]:
                folder = directory/f'{name}-{index}';folder.mkdir()
                target.extend(run(source, folder, 1))
        folder = directory/'warm';folder.mkdir()
        warm = run(ROOT/SOURCE, folder, args.samples+1)
    report = {'baseline_ref': args.baseline_ref, 'baseline_sha256': hashlib.sha256(baseline).hexdigest(),
        'worker_sha256': hashlib.sha256(current).hexdigest(), 'llm_requests': 0, 'microphone': False,
        'playback': 'stubbed; first playable WAV, not physical audibility',
        'percentile': 'nearest-rank; 12 samples are preliminary, not a population guarantee',
        'baseline': summarize(baseline_runs), 'cold': summarize(cold_runs),
        'warmup': warm[0], 'warm': summarize(warm[1:])}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: {k: v for k, v in report[key].items() if k != 'runs'} for key in ['baseline', 'cold', 'warm']}))


if __name__ == '__main__':
    main()
