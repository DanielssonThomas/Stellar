import io
import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
import wave
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/speech/speech_worker.py'
spec = importlib.util.spec_from_file_location('stellar_speech_pipeline', source)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def wav(path):
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\x01\x00' * 160)


class PipelineTests(unittest.TestCase):
    def test_fixed_cached_acknowledgment_uses_validated_playback_without_model_loading(self):
        audio = source.with_name('acknowledgment.wav').read_bytes()
        req = {'text': 'Mm, let me check.', 'cached_wav': base64.b64encode(audio).decode()}
        with tempfile.TemporaryDirectory(prefix='stellar-cached-cue-') as directory:
            target = Path(directory) / 'reply.wav'
            output = io.BytesIO()
            calls = []
            sound = types.SimpleNamespace(PlaySound=lambda *args: calls.append(args), SND_FILENAME=0x20000, SND_NODEFAULT=2)
            with patch.dict(sys.modules, {'winsound': sound}), patch.object(worker.VoiceEngine, 'synthesize', side_effect=AssertionError('must not infer')):
                worker.cached_acknowledgment(req, target, output)
            self.assertEqual(target.read_bytes(), audio)
            frames = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([frame['timing']['stage'] for frame in frames if 'timing' in frame],
                ['synthesis_started', 'first_audio', 'synthesis_completed', 'playback_dispatched', 'playback_completed'])
            self.assertEqual(frames[-1], {'done': True})
            self.assertEqual(calls[0][0], str(target))
            for invalid in [dict(req, text='Different sentence'), dict(req, cached_wav='x'*100001),
                            dict(req, cached_wav='%%%'), dict(req, cached_wav=base64.b64encode(b'tampered').decode())]:
                with self.assertRaises(worker.Failure):
                    worker.cached_acknowledgment(invalid, Path(directory)/'other.wav', io.BytesIO())

    def test_parent_watchdog_blocks_without_polling_and_exits_on_parent_death(self):
        calls = []
        targets = []
        api = types.SimpleNamespace(OpenProcess=lambda *a: calls.append(('open', a)) or 7,
            WaitForSingleObject=lambda *a: calls.append(('wait', a)), INFINITE=0xffffffff,
            CloseHandle=lambda *a: calls.append(('close', a)))
        def exit_process(code):
            raise SystemExit(code)
        def thread(**kwargs):
            targets.append(kwargs)
            return types.SimpleNamespace(start=lambda: None)
        with patch.object(sys, 'platform', 'win32'), patch.dict(sys.modules, {'_winapi': api}), \
             patch.object(worker.threading, 'Thread', side_effect=thread), patch.object(worker.os, '_exit', side_effect=exit_process):
            worker.watch_parent()
            self.assertTrue(targets[0]['daemon'])
            with self.assertRaises(SystemExit):
                targets[0]['target']()
        self.assertEqual(calls[1:], [('wait', (7, 0xffffffff)), ('close', (7,))])

    def test_sentence_boundaries_preserve_words_titles_and_short_phrases(self):
        text = 'Dr. Smith can help today. Yes! We have several options available. The final sentence'
        parts = list(worker.sentences(text))
        self.assertEqual(' '.join(parts), text)
        self.assertEqual(parts[0], 'Dr. Smith can help today.')
        self.assertTrue(parts[1].startswith('Yes! We'))
        self.assertEqual(list(worker.sentences('Version 1.2 works.')), ['Version 1.2 works.'])

    def test_synthesis_overlaps_playback_and_never_overwrites_playing_file(self):
        second_ready = threading.Event()
        first_playing = threading.Event()
        release = threading.Event()
        synthesized = []
        played = []
        failures = []
        text = 'This is the first complete sentence. This is the second complete sentence. This is the third complete sentence.'

        class Engine:
            def synthesize(self, sentence, path):
                self_index = len(synthesized)
                synthesized.append((sentence, path))
                if self_index == 1:
                    if not first_playing.wait(2):
                        raise AssertionError('no overlap')
                wav(path)
                if self_index == 1:
                    second_ready.set()

        def play(path, flags):
            if path is None:
                return
            played.append(Path(path))
            if len(played) == 1:
                first_playing.set()
                self.assertTrue(second_ready.wait(2))
                self.assertEqual(len(synthesized), 2)
                self.assertTrue(Path(path).exists())
                release.wait(2)

        module = types.SimpleNamespace(PlaySound=play, SND_FILENAME=0x20000, SND_NODEFAULT=2)
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, {'winsound': module}):
            protocol = io.BytesIO()
            def run():
                try:
                    worker.synthesize_segments(text, Path(folder)/'reply.wav', Path(folder)/'reply-next.wav', protocol, Engine())
                except BaseException as error:
                    failures.append(error)
            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(second_ready.wait(2))
            self.assertEqual(len(synthesized), 2)
            release.set()
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(played, [item[1] for item in synthesized])
            self.assertEqual(' '.join(item[0] for item in synthesized), text)
            frames = [json.loads(line) for line in protocol.getvalue().splitlines()]
            self.assertEqual(frames.count({'state': 'speaking'}), 1)
            self.assertEqual(frames[-1], {'done': True})
            self.assertEqual(len([frame for frame in frames if 'timing' in frame]), 5)

    def test_playback_failure_stops_producer_and_does_not_emit_done(self):
        class Engine:
            def synthesize(self, text, path):
                wav(path)
        def fail(*args):
            if args[0] is not None:
                raise OSError('device fixture')
        module = types.SimpleNamespace(PlaySound=fail, SND_FILENAME=0x20000, SND_NODEFAULT=2)
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, {'winsound': module}):
            protocol = io.BytesIO()
            with self.assertRaises(OSError):
                worker.synthesize_segments('A sentence that is long enough. Another sentence is queued. A final sentence is queued.',
                    Path(folder)/'reply.wav', Path(folder)/'reply-next.wav', protocol, Engine())
            self.assertNotIn({'done': True}, [json.loads(line) for line in protocol.getvalue().splitlines()])
            self.assertFalse(any(t.name == 'kokoro-synthesis' for t in threading.enumerate()))

    def test_synthesis_failure_does_not_play_or_leak_a_thread(self):
        class Engine:
            def synthesize(self, text, path):
                raise worker.Failure('unavailable')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(worker.Failure):
                worker.synthesize_segments('This is a complete sentence.', Path(folder)/'reply.wav',
                    Path(folder)/'reply-next.wav', io.BytesIO(), Engine())
            self.assertFalse(any(t.name == 'kokoro-synthesis' for t in threading.enumerate()))

    def test_voice_assets_initialize_once_across_consecutive_syntheses(self):
        initialized = []
        requests = []
        class Audio:
            def reshape(self, _): return self
            def __len__(self): return 160
        model = types.SimpleNamespace(create=lambda *a, **k: (requests.append((a, k)) or (Audio(), 16000)))
        class Options:
            def add_session_config_entry(self, *args):
                self.spinning = args
        def load(path, options, providers):
            initialized.append((options, providers))
            return object()
        modules = {
            'numpy': types.SimpleNamespace(asarray=lambda *a, **k: Audio(), float32=float,
                isfinite=lambda _: types.SimpleNamespace(all=lambda: True), max=lambda _: 0.2, abs=lambda x: x),
            'soundfile': types.SimpleNamespace(write=lambda path, *a, **k: wav(path)),
            'onnxruntime': types.SimpleNamespace(SessionOptions=Options, InferenceSession=load),
            'kokoro_onnx': types.SimpleNamespace(Kokoro=types.SimpleNamespace(from_session=lambda *a: model)),
        }
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, modules), patch.object(Path, 'is_file', return_value=True):
            engine = worker.VoiceEngine()
            engine.configure({'speed': 1.05})
            for index in range(3):
                engine.synthesize('A fixed synthetic sentence.', Path(folder)/f'{index}.wav')
        self.assertEqual(len(initialized), 1)
        self.assertEqual(initialized[0][1], ['CPUExecutionProvider'])
        self.assertEqual(initialized[0][0].spinning, ('session.intra_op.allow_spinning', '0'))
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(k == {'voice': 'af_heart', 'speed': 1.05, 'lang': 'en-us'} for _, k in requests))


if __name__ == '__main__':
    unittest.main()
