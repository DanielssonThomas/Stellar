"""Offline speech worker; lifecycle and temporary ownership are native-owned."""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import contextlib
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import wave
import queue
import re
import threading
import time

PROFILE = Path('D:/Hermes/profiles/ivy')
VOICE = PROFILE / 'voice'
MAX_REQUEST = 3 * 1024 * 1024
MAX_RESPONSE = 16 * 1024
MAX_WAV = 8 * 1024 * 1024
CACHED_ACKNOWLEDGMENT_SHA256 = '762c2f8958c715db47b92c4f80028b38eb0e4e84c09bdb11531e1696d783eee8'
PROTOCOL_LOCK = threading.Lock()

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


def request(eof=False):
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    if eof and not raw:
        return None
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
    with PROTOCOL_LOCK:
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
        if section.get('language') not in (None, '', 'auto', 'en'):
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
    if kwargs.get('vad_filter') is not True:
        reject('unavailable')
    # Short English commands cannot reliably identify their own language.
    kwargs['language'] = 'en'
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


class VoiceEngine:
    def __init__(self):
        self.model = None
        self.settings = None

    def configure(self, settings):
        self.settings = dict(settings)

    def synthesize(self, text, target):
        import numpy as np
        import soundfile as sf
        if self.model is None:
            for name in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
                if not (VOICE / 'models' / name).is_file():
                    reject('model_missing')
            import onnxruntime as ort
            from kokoro_onnx import Kokoro
            options = ort.SessionOptions()
            options.intra_op_num_threads = 4
            options.inter_op_num_threads = 1
            options.add_session_config_entry('session.intra_op.allow_spinning', '0')
            session = ort.InferenceSession(str(VOICE / 'models/kokoro-v1.0.onnx'), options,
                                          providers=['CPUExecutionProvider'])
            self.model = Kokoro.from_session(session, str(VOICE / 'models/voices-v1.0.bin'))
        audio, rate = self.model.create(text, voice='af_heart', speed=self.settings['speed'], lang='en-us')
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        if (not len(audio) or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.0001
                or len(audio) > rate * 90 or len(audio) * 2 + 44 > MAX_WAV):
            reject('unavailable')
        partial = target.with_suffix('.tmp.wav')
        sf.write(partial, audio, rate, subtype='PCM_16')
        partial.replace(target)


def sentences(text):
    """Only split completed prose, retaining punctuation and combining short phrases."""
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z0-9])', text)
    pending = ''
    for part in parts:
        pending = f'{pending} {part}'.strip() if pending else part
        # Avoid fragmenting initials, titles, decimals and very short utterances.
        if len(pending) >= 18 and not re.search(r'\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e)\.$', pending):
            yield pending
            pending = ''
    if pending:
        yield pending


def speak(req, protocol, engine=None):
    if set(req) not in ({'text', 'output'}, {'text', 'output', 'cached_wav'}):
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
    alternate = target.with_name('reply-next.wav')
    if alternate.exists() or alternate.is_symlink() or alternate.with_suffix('.tmp.wav').exists():
        reject()
    emit(protocol, {'state': 'synthesizing'})
    if 'cached_wav' in req:
        cached_acknowledgment(req, target, protocol)
        return
    engine = engine or VoiceEngine()
    engine.configure(settings)
    synthesize_segments(text, target, alternate, protocol, engine)


def cached_acknowledgment(req, target, protocol):
    encoded = req['cached_wav']
    if (req['text'] != 'Mm, let me check.' or type(encoded) is not str
            or len(encoded) > 100_000):
        reject()
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeError):
        reject()
    if hashlib.sha256(audio).hexdigest() != CACHED_ACKNOWLEDGMENT_SHA256:
        reject()
    started = time.perf_counter()
    def timing(stage):
        emit(protocol, {'timing': {'stage': stage, 'elapsed_ms': round((time.perf_counter()-started)*1000)}})
    timing('synthesis_started')
    with target.open('xb') as output:
        output.write(audio)
    timing('first_audio')
    timing('synthesis_completed')
    playback(target, protocol, terminal=False, on_dispatch=lambda: timing('playback_dispatched'))
    timing('playback_completed')
    emit(protocol, {'done': True})


def synthesize_segments(text, target, alternate, protocol, engine):
    started = time.perf_counter()
    def timing(stage):
        emit(protocol, {'timing': {'stage': stage, 'elapsed_ms': round((time.perf_counter() - started) * 1000)}})

    timing('synthesis_started')
    ready = queue.Queue(maxsize=1)
    free = queue.Queue(maxsize=2)
    for path in (target, alternate):
        free.put(path)
    cancelled = threading.Event()

    def offer(value):
        while not cancelled.is_set():
            try:
                ready.put(value, timeout=0.05)
                return
            except queue.Full:
                pass

    def produce():
        used = set()
        first_audio = True
        try:
            for sentence in sentences(text):
                while not cancelled.is_set():
                    try:
                        path = free.get(timeout=0.05)
                        break
                    except queue.Empty:
                        pass
                else:
                    return
                if path in used:
                    path.unlink()
                used.add(path)
                engine.synthesize(sentence, path)
                if first_audio:
                    timing('first_audio')
                    first_audio = False
                offer(path)
            timing('synthesis_completed')
            offer(None)
        except BaseException as error:
            offer(error)

    producer = threading.Thread(target=produce, name='kokoro-synthesis')
    producer.start()
    first = True
    try:
        while True:
            result = ready.get()
            if result is None:
                break
            if isinstance(result, BaseException):
                raise result
            playback(result, protocol, first=first, terminal=False,
                     on_dispatch=lambda: timing('playback_dispatched') if first else None)
            first = False
            free.put(result)
        timing('playback_completed')
        emit(protocol, {'done': True})
    finally:
        cancelled.set()
        producer.join()


def playback(target, protocol, first=True, terminal=True, on_dispatch=lambda: None):
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
    import winsound
    try:
        if first:
            emit(protocol, {'state': 'speaking'})
        on_dispatch()
        # Synchronous playback is the default; Python 3.12 has no named SND_SYNC.
        winsound.PlaySound(str(target), winsound.SND_FILENAME | winsound.SND_NODEFAULT)
    finally:
        winsound.PlaySound(None, 0)
    if terminal:
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
                if sys.argv[1] == 'transcribe':
                    transcribe(request(), protocol)
                else:
                    watch_parent()
                    emit(protocol, {'audio_process': os.getpid()})
                    engine = VoiceEngine()
                    while (req := request(eof=True)) is not None:
                        speak(req, protocol, engine)
            except Failure as exc:
                emit(protocol, {'error': exc.code})
            except (UnicodeError, json.JSONDecodeError, RecursionError):
                emit(protocol, {'error': 'protocol'})
            except BaseException:
                emit(protocol, {'error': 'unavailable'})


def watch_parent():
    if sys.platform != 'win32':
        return
    import _winapi
    handle = _winapi.OpenProcess(0x100000, False, os.getppid())
    def wait():
        try:
            _winapi.WaitForSingleObject(handle, _winapi.INFINITE)
            os._exit(1)
        finally:
            _winapi.CloseHandle(handle)
    threading.Thread(target=wait, name='speech-parent', daemon=True).start()


if __name__ == '__main__':
    main()
