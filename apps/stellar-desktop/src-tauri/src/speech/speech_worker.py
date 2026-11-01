"""One-request offline speech worker; lifecycle and temporary ownership are native-owned."""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import contextlib
import importlib.util
import json
import math
import os
from pathlib import Path
import wave

PROFILE = Path('D:/Hermes/profiles/ivy')
VOICE = PROFILE / 'voice'
MAX_REQUEST = 3 * 1024 * 1024
MAX_RESPONSE = 16 * 1024
MAX_WAV = 8 * 1024 * 1024

for _key, _value in {
    'HF_HUB_OFFLINE': '1',
    'HF_HUB_DISABLE_TELEMETRY': '1',
    'CUDA_VISIBLE_DEVICES': '',
    'ONNX_PROVIDER': 'CPUExecutionProvider',
    'PYTHONDONTWRITEBYTECODE': '1',
    'HERMES_HOME': str(PROFILE),
}.items():
    os.environ[_key] = _value


class Failure(Exception):
    def __init__(self, code):
        self.code = code


def reject(code='protocol'):
    raise Failure(code)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result


def invalid_constant(_value):
    reject()


def decode_json(raw):
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                      parse_constant=invalid_constant)


def read_bounded(path, limit):
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        reject('unavailable')
    return data


def request():
    # One frame only: do not wait for EOF or attempt a second request.
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    if not raw or len(raw) > MAX_REQUEST or not raw.endswith(b'\n'):
        reject()
    result = decode_json(raw)
    if type(result) is not dict:
        reject()
    return result


def emit(stream, value):
    raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    if len(raw) > MAX_RESPONSE:
        reject('unavailable')
    stream.write(raw)
    stream.flush()


def utf8_size(value):
    try:
        return len(value.encode('utf-8'))
    except UnicodeError:
        reject()


def same_path(left, right):
    return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


def load_stt_config():
    import yaml

    class UniqueLoader(yaml.SafeLoader):
        pass

    def mapping(loader, node):
        pairs = []
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=True)
            if type(key) is not str:
                reject('unavailable')
            pairs.append((key, loader.construct_object(value_node, deep=True)))
        return unique_object(pairs)

    UniqueLoader.add_constructor('tag:yaml.org,2002:map', mapping)
    raw = read_bounded(PROFILE / 'config.yaml', 128 * 1024)
    # Aliases are unnecessary here and can produce recursive structures.
    if any(isinstance(token, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken))
           for token in yaml.scan(raw)):
        reject('unavailable')
    config = yaml.load(raw, Loader=UniqueLoader)
    return validate_stt_config(config)


def validate_stt_config(config):
    if type(config) is not dict or type(config.get('stt')) is not dict:
        reject('unavailable')
    stt = config['stt']
    local = stt.get('local')
    if (stt.get('enabled') is not True or stt.get('provider') != 'local'
            or type(local) is not dict):
        reject('unavailable')
    required = {'model': 'base', 'device': 'cpu', 'compute_type': 'int8', 'vad': True}
    for key, value in required.items():
        if type(local.get(key)) is not type(value) or local[key] != value:
            reject('unavailable')
    for section in (stt, local):
        if section.get('language') not in (None, '', 'auto'):
            reject('unavailable')
    return stt


def transcribe(req, protocol):
    if set(req) != {'pcm', 'sample_rate_hz'}:
        reject()
    pcm = req['pcm']
    if (type(req['sample_rate_hz']) is not int or req['sample_rate_hz'] != 16000
            or type(pcm) is not list or len(pcm) > 320000):
        reject()
    if any(type(value) is not int or not -32768 <= value <= 32767 for value in pcm):
        reject()
    workspace = Path(sys.executable).parents[2] / 'workspace'
    if not workspace.is_dir():
        reject('unavailable')
    sys.path.insert(0, str(workspace))
    stt = load_stt_config()
    import numpy as np
    from faster_whisper import WhisperModel
    from tools.transcription_tools import (
        build_local_transcribe_kwargs, _join_confident_segments,
    )
    kwargs = build_local_transcribe_kwargs(stt)
    if kwargs.get('language') or kwargs.get('vad_filter') is not True:
        reject('unavailable')
    emit(protocol, {'state': 'transcribing'})
    try:
        model = WhisperModel('base', device='cpu', compute_type='int8',
                             local_files_only=True, cpu_threads=4)
    except Exception as exc:
        # Do not classify arbitrary runtime/model failures using exception text.
        if any(cls.__name__ == 'LocalEntryNotFoundError' for cls in type(exc).__mro__):
            reject('model_missing')
        raise
    audio = np.asarray(pcm, dtype=np.float32) / np.float32(32768)
    if not pcm:
        emit(protocol, {'text': ''})
        return
    segments, _info = model.transcribe(audio, **kwargs)
    text = _join_confident_segments(segments, stt['local'])
    if type(text) is not str or utf8_size(text) > 8192:
        reject('unavailable')
    emit(protocol, {'text': text})


def speech_settings():
    settings = decode_json(read_bounded(VOICE / 'local-persona.json', 16 * 1024))
    if type(settings) is not dict:
        reject('unavailable')
    if settings.get('engine') != 'kokoro' or settings.get('voice') != 'af_heart':
        reject('unavailable')
    if type(settings.get('cpu_threads')) is not int or settings['cpu_threads'] != 4:
        reject('unavailable')
    speed = settings.get('speed')
    maximum = settings.get('max_characters')
    if (type(speed) not in (int, float) or not math.isfinite(speed)
            or not 0.8 <= speed <= 1.2 or type(maximum) is not int
            or not 1 <= maximum <= 8000):
        reject('unavailable')
    return settings


def speak(req, protocol):
    if set(req) != {'text', 'output'}:
        reject()
    text, output = req['text'], req['output']
    if type(text) is not str or not text.strip() or utf8_size(text) > 4000:
        reject()
    if type(output) is not str or not output or len(output) > 4096 or '\x00' in output:
        reject()
    target = Path(output)
    if (not target.is_absolute() or target.suffix.lower() != '.wav'
            or '..' in target.parts or not target.parent.is_dir()
            or target.exists() or target.is_symlink()
            or target.with_suffix('.tmp.wav').exists()):
        reject()
    if not same_path(Path(sys.executable), VOICE / '.venv' / 'Scripts' / 'python.exe'):
        reject('unavailable')
    settings = speech_settings()
    if len(text) > settings['max_characters']:
        reject()
    for name in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
        if not (VOICE / 'models' / name).is_file():
            reject('model_missing')
    spec = importlib.util.spec_from_file_location('_ivy_local_voice_worker', VOICE / 'local_worker.py')
    if spec is None or spec.loader is None:
        reject('unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    emit(protocol, {'state': 'synthesizing'})
    module.Engine().synthesize({'text': text, 'output': str(target),
                               'engine': 'kokoro', 'voice': 'af_heart'})
    if not target.is_file() or target.stat().st_size > MAX_WAV:
        reject('unavailable')
    with wave.open(str(target), 'rb') as wav:
        rate, frames = wav.getframerate(), wav.getnframes()
        if (wav.getnchannels() != 1 or wav.getsampwidth() != 2
                or wav.getcomptype() != 'NONE' or not 8000 <= rate <= 192000
                or frames <= 0 or frames > rate * 90):
            reject('unavailable')
        audio = wav.readframes(frames)
        if len(audio) != frames * 2:
            reject('unavailable')
    import numpy as np
    import sounddevice as sd
    try:
        emit(protocol, {'state': 'speaking'})
        sd.play(np.frombuffer(audio, dtype='<i2'), samplerate=rate, blocking=False)
        sd.wait()
    finally:
        sd.stop()
    emit(protocol, {'done': True})


def main():
    # Preserve a private protocol descriptor; redirect Python AND native stdout.
    sys.stdout.flush()
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        with contextlib.redirect_stdout(sys.stderr):
            try:
                if len(sys.argv) != 2 or sys.argv[1] not in ('transcribe', 'speak'):
                    reject()
                req = request()
                (transcribe if sys.argv[1] == 'transcribe' else speak)(req, protocol)
            except Failure as exc:
                emit(protocol, {'error': exc.code})
            except (UnicodeError, json.JSONDecodeError, RecursionError):
                emit(protocol, {'error': 'protocol'})
            except BaseException:
                emit(protocol, {'error': 'unavailable'})


if __name__ == '__main__':
    main()
