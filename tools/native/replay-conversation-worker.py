"""Private benchmark bridge, never installed/launched by Stellar."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

with contextlib.redirect_stdout(sys.stderr):
    worker = load(root/'apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py', 'worker')
    harness = load(root/'tools/native/benchmark-recognition.py', 'harness')
    kws, stt = worker.Keywords(), worker.Transcriber()
folder = Path(sys.argv[1]).resolve()
manifest = json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
while True:
    line = sys.stdin.buffer.readline(3*1024*1024 + 1)
    if not line:
        break
    if len(line) > 3*1024*1024:
        raise ValueError('Oversized benchmark request')
    request = json.loads(line)
    with contextlib.redirect_stdout(sys.stderr):
        if request['kind'] == 'fixture':
            trial = manifest['trials'][request['index']]
            path = (folder/(trial['id']+'.wav')).resolve()
            if path.parent != folder:
                raise ValueError('Fixture must remain in selected directory')
            audio = harness.pcm(path)
            if len(audio) > 720000:
                raise ValueError('Oversized fixture')
            result = {'pcm': audio.tolist()}
        elif request['kind'] == 'keywords':
            result = kws.run(request['request'])
        elif request['kind'] == 'transcribe':
            result = stt.run(request['request'])
        else:
            raise ValueError('Unknown benchmark operation')
    print(json.dumps(result, separators=(',', ':')), flush=True)
