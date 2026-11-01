import hashlib
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import wave
import numpy as np

parser = argparse.ArgumentParser(description='Explicit offline synthetic-engine qualification; no microphone or audible playback.')
parser.add_argument('--run-local-engines', action='store_true', required=True)
parser.parse_args()
REPOSITORY = Path(__file__).resolve().parents[2]
ROOT = REPOSITORY / 'artifacts/native'
ROOT.mkdir(parents=True, exist_ok=True)
WORKER = REPOSITORY / 'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py'
SAMPLE = Path('D:/Hermes/profiles/ivy/voice/samples-local/kokoro-af_heart-friendly.wav')
VOICE_PYTHON = Path('D:/Hermes/profiles/ivy/voice/.venv/Scripts/python.exe')
evidence = {'synthetic': True, 'microphoneUsed': False, 'llmRequests': 0, 'audiblePlayback': False,
            'workerSha256': hashlib.sha256(WORKER.read_bytes()).hexdigest(),
            'sample': str(SAMPLE), 'sampleSha256': hashlib.sha256(SAMPLE.read_bytes()).hexdigest()}
with wave.open(str(SAMPLE), 'rb') as audio:
    assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
    rate = audio.getframerate()
    pcm = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
resampled = np.interp(np.arange(int(len(pcm)*16000/rate))*rate/16000, np.arange(len(pcm)), pcm).round().astype(np.int16).tolist()
def transcribe(pcm):
    start = time.monotonic()
    result = subprocess.run([sys.executable, '-I', '-u', str(WORKER), 'transcribe'],
                            input=json.dumps({'pcm': pcm, 'sample_rate_hz': 16000})+'\n',
                            capture_output=True, text=True, timeout=60,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    return {'exitCode': result.returncode, 'durationMs': round((time.monotonic()-start)*1000),
            'sampleCount': len(pcm), 'frames': frames, 'stderrBytes': len(result.stderr.encode())}
evidence['transcription'] = transcribe(resampled)
evidence['silence'] = transcribe([0]*16000)
folder = ROOT/'offline-tts'
folder.mkdir(exist_ok=False)
wrapper = '''import contextlib,importlib.util,io,json,sys,types,wave
from pathlib import Path
spec=importlib.util.spec_from_file_location('speech_worker',sys.argv[1]);worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
calls=[]
def play(pcm,samplerate,blocking):calls.append({'frames':len(pcm),'sampleRate':samplerate,'blocking':blocking})
sys.modules['sounddevice']=types.SimpleNamespace(play=play,wait=lambda:calls.append('wait'),stop=lambda:calls.append('stop'))
protocol=io.BytesIO()
with contextlib.redirect_stdout(sys.stderr):worker.speak({'text':'Stellar local speech qualification.','output':sys.argv[2]},protocol)
with wave.open(sys.argv[2],'rb') as wav:metadata={'frames':wav.getnframes(),'sampleRate':wav.getframerate(),'channels':wav.getnchannels(),'sampleWidth':wav.getsampwidth()}
print(json.dumps({'frames':[json.loads(line) for line in protocol.getvalue().splitlines()],'playbackStubCalls':calls,'wav':metadata}))
'''
start = time.monotonic()
try:
    result = subprocess.run([str(VOICE_PYTHON),'-I','-c',wrapper,str(WORKER),str(folder/'reply.wav')],
                            capture_output=True,text=True,timeout=40,creationflags=subprocess.CREATE_NO_WINDOW)
    evidence['synthesis'] = {'exitCode':result.returncode,'durationMs':round((time.monotonic()-start)*1000),
                             'result':json.loads(result.stdout) if result.stdout.strip() else None,
                             'stderrBytes':len(result.stderr.encode())}
finally:
    for name in ['reply.wav','reply.tmp.wav']:
        (folder/name).unlink(missing_ok=True)
    folder.rmdir()
evidence['temporaryOutputRemoved'] = not folder.exists()
(ROOT/'speech-offline-qualification.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
print(json.dumps(evidence))
