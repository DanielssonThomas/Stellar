import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py'
spec = importlib.util.spec_from_file_location('stellar_speech_worker', SOURCE)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def config():
    return {'stt': {'enabled': True, 'provider': 'local', 'language': '',
                    'local': {'model': 'base', 'device': 'cpu', 'compute_type': 'int8',
                              'vad': True, 'language': ''}}}


class SpeechWorkerTests(unittest.TestCase):
    def test_speech_rejects_arbitrary_options_and_nonlocal_persona(self):
        for request in [{'text': 'hello', 'output': 'relative.wav'},
                        {'text': 'hello', 'output': 'unused.wav', 'engine': 'cloud'},
                        {'text': '界' * 1334, 'output': 'unused.wav'},
                        {'text': ' ', 'output': 'unused.wav'}]:
            with self.assertRaises(worker.Failure):
                worker.speak(request, io.BytesIO())
        valid = {'engine': 'kokoro', 'voice': 'af_heart', 'cpu_threads': 4,
                 'speed': 1.0, 'max_characters': 8000}
        for key, value in [('engine', 'gemini'), ('engine', 'pocket'), ('voice', 'other'),
                           ('cpu_threads', 16), ('speed', float('inf'))]:
            invalid = dict(valid, **{key: value})
            with patch.object(worker, 'read_bounded', return_value=json.dumps(invalid).encode()):
                with self.assertRaises(worker.Failure):
                    worker.speech_settings()

    def test_configuration_never_selects_cloud_or_another_engine(self):
        self.assertEqual(worker.validate_stt_config(config())['provider'], 'local')
        for section, key, value in [('stt', 'provider', 'openai'), ('stt', 'enabled', False),
                                    ('local', 'device', 'cuda'), ('local', 'vad', False),
                                    ('local', 'model', 'large'), ('local', 'compute_type', 'auto')]:
            candidate = config()
            target = candidate['stt'] if section == 'stt' else candidate['stt']['local']
            target[key] = value
            with self.assertRaises(worker.Failure):
                worker.validate_stt_config(candidate)

    def test_malformed_and_oversized_pcm_never_loads_a_model(self):
        with patch.object(worker, 'load_stt_config', side_effect=AssertionError('model path reached')):
            for request in [{'pcm': [True], 'sample_rate_hz': 16000},
                            {'pcm': [32768], 'sample_rate_hz': 16000},
                            {'pcm': [0], 'sample_rate_hz': 48000},
                            {'pcm': [0] * 320001, 'sample_rate_hz': 16000},
                            {'pcm': [0], 'sample_rate_hz': 16000, 'provider': 'cloud'}]:
                with self.assertRaises(worker.Failure):
                    worker.transcribe(request, io.BytesIO())

    def test_json_duplicates_nonfinite_and_request_bound_are_rejected(self):
        for raw in [b'{"pcm":[],"pcm":[]}', b'{"pcm":[NaN]}']:
            with self.assertRaises(worker.Failure):
                worker.decode_json(raw)
        for raw in [b'{}', b'x' * (worker.MAX_REQUEST + 1)]:
            with patch.object(worker.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(raw))):
                with self.assertRaises(worker.Failure):
                    worker.request()

    def test_unicode_transcript_uses_utf8_bound_without_ascii_expansion(self):
        output = io.BytesIO()
        worker.emit(output, {'text': '界' * 2730})
        self.assertLess(len(output.getvalue()), 16384)
        self.assertEqual(json.loads(output.getvalue())['text'], '界' * 2730)

    def test_local_constructor_has_no_download_retry_and_silence_stays_empty(self):
        calls = []
        class Array:
            def __truediv__(self, divisor):
                self.divisor = divisor
                return self
        class Model:
            def __init__(self, *args, **kwargs):
                calls.append((args, kwargs))
            def transcribe(self, audio, **kwargs):
                self.kwargs = kwargs
                return iter([]), None
        modules = {
            'numpy': types.SimpleNamespace(asarray=lambda *args, **kwargs: Array(), float32=float),
            'faster_whisper': types.SimpleNamespace(WhisperModel=Model),
            'tools.transcription_tools': types.SimpleNamespace(
                build_local_transcribe_kwargs=lambda cfg: {'vad_filter': True, 'condition_on_previous_text': False},
                _join_confident_segments=lambda segments, cfg: ' '.join(segments)),
        }
        with patch.dict(sys.modules, modules), patch.object(worker, 'load_stt_config', return_value=config()['stt']), \
             patch.object(Path, 'is_dir', return_value=True), patch.object(sys, 'path', list(sys.path)):
            output = io.BytesIO()
            worker.transcribe({'pcm': [0] * 1600, 'sample_rate_hz': 16000}, output)
            self.assertEqual(json.loads(output.getvalue().splitlines()[-1]), {'text': ''})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], (('base',), {'device': 'cpu', 'compute_type': 'int8',
                                             'local_files_only': True, 'cpu_threads': 4}))

    def test_missing_cache_never_retries_or_calls_cloud(self):
        class LocalEntryNotFoundError(Exception):
            pass
        def missing(*args, **kwargs):
            raise LocalEntryNotFoundError()
        modules = {
            'numpy': types.SimpleNamespace(),
            'faster_whisper': types.SimpleNamespace(WhisperModel=missing),
            'tools.transcription_tools': types.SimpleNamespace(
                build_local_transcribe_kwargs=lambda cfg: {'vad_filter': True},
                _join_confident_segments=lambda *args: 'must not run'),
        }
        with patch.dict(sys.modules, modules), patch.object(worker, 'load_stt_config', return_value=config()['stt']), \
             patch.object(Path, 'is_dir', return_value=True), patch.object(sys, 'path', list(sys.path)):
            with self.assertRaises(worker.Failure) as caught:
                worker.transcribe({'pcm': [0], 'sample_rate_hz': 16000}, io.BytesIO())
        self.assertEqual(caught.exception.code, 'model_missing')


if __name__ == '__main__':
    unittest.main()
