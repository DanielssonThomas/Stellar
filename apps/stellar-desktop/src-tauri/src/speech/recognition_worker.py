"""Offline CPU engines. Fixed assets; one bounded reply for each bounded request."""
from __future__ import annotations

import contextlib
import json
import math
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
for key, value in {'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1',
                   'CUDA_VISIBLE_DEVICES': '', 'PYTHONDONTWRITEBYTECODE': '1'}.items():
    os.environ[key] = value

ROOT = Path('D:/Hermes/profiles/ivy/recognition/models')
KWS = ROOT / 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
WAKE = ROOT / 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
STT = ROOT / 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
MAX_FRAME = 3 * 1024 * 1024


class Rejected(Exception):
    pass


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected()
        result[key] = value
    return result


def invalid(_value):
    raise Rejected()


def samples(request, maximum):
    pcm = request.get('pcm')
    if (type(pcm) is not list or not 1 <= len(pcm) <= maximum
            or any(type(x) is not int or not -32768 <= x <= 32767 for x in pcm)):
        raise Rejected()
    import numpy as np
    return np.asarray(pcm, dtype=np.float32) / np.float32(32768)


def files(root, names):
    paths = {key: str(root / name) for key, name in names.items()}
    if any(not Path(path).is_file() for path in paths.values()):
        raise FileNotFoundError()
    return paths


class Transcriber:
    def __init__(self):
        import sherpa_onnx
        self.model = sherpa_onnx.OfflineRecognizer.from_transducer(
            **files(STT, {'encoder': 'encoder.int8.onnx', 'decoder': 'decoder.int8.onnx',
                          'joiner': 'joiner.int8.onnx', 'tokens': 'tokens.txt'}),
            model_type='nemo_transducer', num_threads=2, provider='cpu')

    def run(self, request):
        if set(request) != {'pcm', 'sample_rate_hz'} or type(request['sample_rate_hz']) is not int or request['sample_rate_hz'] != 16000:
            raise Rejected()
        audio = samples(request, 320000)
        stream = self.model.create_stream()
        stream.accept_waveform(16000, audio)
        self.model.decode_stream(stream)
        text = stream.result.text
        if type(text) is not str or len(text.encode('utf-8')) > 8192:
            raise Rejected()
        return {'text': text}


class Keywords:
    def __init__(self, command_paths=8, phoneme_wake=False, bpe_wake=False):
        self.command_silence = command_silence()
        import sherpa_onnx
        suffix = '-epoch-13-avg-2-chunk-8-left-64'
        self.commands = sherpa_onnx.KeywordSpotter(
            **files(KWS, {'encoder': 'encoder' + suffix + '.onnx', 'decoder': 'decoder' + suffix + '.onnx',
                          'joiner': 'joiner' + suffix + '.onnx', 'tokens': 'tokens.txt',
                          'keywords_file': 'stellar-empty.txt'}),
            num_threads=1, provider='cpu', max_active_paths=command_paths, keywords_score=1.0,
            keywords_threshold=0.65, num_trailing_blanks=1)
        suffix = '-epoch-12-avg-2-chunk-16-left-64.int8.onnx'
        self.wake = sherpa_onnx.KeywordSpotter(
            **files(WAKE, {'encoder': 'encoder' + suffix, 'decoder': 'decoder' + suffix,
                           'joiner': 'joiner' + suffix, 'tokens': 'tokens.txt',
                           'keywords_file': 'stellar-empty.txt'}), num_threads=1, provider='cpu')
        self.model = self.wake
        self.wake_vocabulary = (WAKE / 'stellar-keywords.txt').read_text(encoding='utf-8').splitlines()
        self.vocabulary = (KWS / 'stellar-keywords.txt').read_text(encoding='utf-8').splitlines()
        if phoneme_wake:
            self.wake = self.commands
            self.wake_vocabulary = self.vocabulary
        self.ensemble_wake = not phoneme_wake and not bpe_wake
        self.identity = None
        self.reset()

    def reset(self):
        self.stream = None
        self.secondary_stream = None
        self.offset = 0
        self.origin = 0
        self.onset = 0
        self.preroll = []
        self.quiet = 0
        self.last_voice = 0
        self.candidate = None
        self.fired = False
        self.sequence = None

    def decode(self, audio):
        self.decode_stream(self.model, self.stream, audio)
        if self.secondary_stream is not None:
            self.decode_stream(self.commands, self.secondary_stream, audio)

    def decode_stream(self, model, stream, audio):
        stream.accept_waveform(16000, audio)
        while model.is_ready(stream):
            model.decode_stream(stream)
            result = model.keyword_spotter.get_result(stream)
            keyword = result.keyword.strip().replace('_', ' ')
            if keyword:
                times = result.timestamps
                if times:
                    start = self.origin + round(times[0] * 16000)
                    end = self.origin + round(times[-1] * 16000)
                    # Only the phrase onset may be a command. A later match is dictation.
                    onset_slack = 4480 if model is self.wake and model is not self.commands else 2560
                    if start <= self.onset + onset_slack:
                        self.candidate = (keyword, start, end)

    def run(self, request):
        if set(request) != {'stream_id', 'sequence', 'pcm', 'threshold', 'mode'}:
            raise Rejected()
        identity, sequence = request['stream_id'], request['sequence']
        threshold, mode = request['threshold'], request['mode']
        if (type(identity) is not str or not 1 <= len(identity) <= 96
                or type(sequence) is not int or not 0 <= sequence <= 9007199254740991
                or type(threshold) not in (int, float) or not math.isfinite(threshold)
                or not 0.001 <= threshold <= 0.2
                or mode not in ('passive', 'passive_sensitive', 'listening', 'composing')):
            raise Rejected()
        audio = samples(request, 640)
        passive = mode in ('passive', 'passive_sensitive')
        key = (identity, mode)
        if key != self.identity or (self.sequence is not None and sequence != self.sequence + 1):
            self.reset()
            self.identity = key
        self.sequence = sequence
        import numpy as np
        # A quieter suffix still belongs to the phrase after a clear onset.
        voice_threshold = threshold if self.stream is None else threshold * 0.6
        voiced = float(np.sqrt(np.mean(audio * audio))) >= voice_threshold
        previous = self.offset
        self.offset += len(audio)
        detection = None
        if self.stream is None:
            if not voiced:
                self.preroll = (self.preroll + audio.tolist())[-3840:]
                return {'sequence': sequence, 'detection': None}
            labels = {'ivy'} if passive else {
                'done', "i'm_done", 'im_done', 'i_am_done', 'thats_all', 'that_is_all',
                'clear', 'new_session',
                *({'prompt_cancel'} if mode == 'composing' else {'prompt', 'reload_mcp'})}
            self.model = self.wake if passive else self.commands
            selected = self.wake_vocabulary if passive else self.vocabulary
            vocabulary = '/'.join(line for line in selected if line.rsplit('@', 1)[-1] in labels)
            if passive:
                if self.model is self.commands:
                    vocabulary += '/HH EY1 AY1 V IY0 :1.0 #0.35 @ivy/AY1 V IY1 :1.5 #0.15 @ivy'
                    if mode == 'passive_sensitive':
                        vocabulary += '/AY1 V :1.0 #0.25 @ivy/AY1 M IY1 N :1.0 #0.25 @ivy/IH1 R IY0 :1.5 #0.15 @ivy/IY1 R IY0 :1.5 #0.15 @ivy'
                else:
                    vocabulary += '/\u2581HE Y \u2581I V Y :1.0 #0.35 @ivy'
                    if mode == 'passive_sensitive':
                        vocabulary += "/\u2581I ' VE :1.0 #0.25 @ivy/\u2581I \u2581MEAN :1.0 #0.25 @ivy"
            self.stream = self.model.create_stream(vocabulary)
            if passive and self.ensemble_wake:
                secondary = '/'.join(line for line in self.vocabulary if line.rsplit('@', 1)[-1] == 'ivy')
                secondary += '/HH EY1 AY1 V IY0 :1.0 #0.35 @ivy/AY1 V IY1 :1.5 #0.15 @ivy'
                if mode == 'passive_sensitive':
                    secondary += '/AY1 V :1.0 #0.25 @ivy/AY1 M IY1 N :1.0 #0.25 @ivy/IH1 R IY0 :1.5 #0.15 @ivy/IY1 R IY0 :1.5 #0.15 @ivy'
                self.secondary_stream = self.commands.create_stream(secondary)
            self.origin = previous - len(self.preroll)
            self.onset = previous
            self.decode(np.asarray(self.preroll, dtype=np.float32))
            self.preroll = []
        self.quiet = 0 if voiced else self.quiet + len(audio)
        if voiced:
            self.last_voice = self.offset
        if not self.fired:
            if self.offset - self.origin > 96000:
                self.fired = True
        if not self.fired:
            self.decode(audio)
            if self.candidate:
                command, start, end = self.candidate
                if command in ("i'm done", 'im done', 'i am done', 'thats all', 'that is all'):
                    command = 'done'
                allowed = command == 'ivy' if passive else command != 'ivy'
                allowed = allowed and (command != 'prompt cancel' or mode == 'composing')
                if allowed and (command == 'ivy' or self.quiet >= self.command_silence):
                    # A standalone control must account for the end of all voiced audio.
                    if command == 'ivy' or self.last_voice - end <= 2560:
                        detection = {'command': command, 'end_sample': max(0, end + 640)}
                    self.fired = True
        if self.quiet >= max(12800, self.command_silence + 2560):
            self.stream = None
            self.secondary_stream = None
            self.candidate = None
            self.fired = False
        return {'sequence': sequence, 'detection': detection}


def command_silence():
    settings = ROOT.parent / 'recognition-settings.json'
    if not settings.exists():
        return 3840
    with settings.open('rb') as source:
        raw = source.read(4097)
    if len(raw) > 4096:
        raise Rejected()
    config = json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=invalid)
    if type(config) is not dict or set(config) != {'command_silence_ms'}:
        raise Rejected()
    value = config['command_silence_ms']
    if type(value) is not int or not 200 <= value <= 800:
        raise Rejected()
    return value * 16


def emit(protocol, value):
    raw = (json.dumps(value, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')
    if len(raw) > 16384:
        raise Rejected()
    protocol.write(raw)
    protocol.flush()


def main():
    sys.stdout.flush()
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        with contextlib.redirect_stdout(sys.stderr):
            try:
                if len(sys.argv) != 2 or sys.argv[1] not in ('keywords', 'transcribe'):
                    raise Rejected()
                engine = Keywords() if sys.argv[1] == 'keywords' else Transcriber()
                while True:
                    raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
                    if not raw:
                        return
                    if len(raw) > MAX_FRAME or not raw.endswith(b'\n'):
                        raise Rejected()
                    request = json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=invalid)
                    if type(request) is not dict:
                        raise Rejected()
                    emit(protocol, engine.run(request))
            except FileNotFoundError:
                emit(protocol, {'error': 'model_missing'})
            except (Rejected, UnicodeError, ValueError, RecursionError):
                emit(protocol, {'error': 'protocol'})
            except BaseException:
                emit(protocol, {'error': 'unavailable'})


if __name__ == '__main__':
    main()
