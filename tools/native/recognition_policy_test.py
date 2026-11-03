"""Deterministic policy tests with inert acoustic results, without inference packages."""
import importlib.util
import math
from pathlib import Path
import types
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/speech/recognition_worker.py'
spec = importlib.util.spec_from_file_location('recognition_policy_worker', source)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Audio(list):
    def __mul__(self, other):
        return Audio(a * b for a, b in zip(self, other))

    def tolist(self):
        return list(self)


class Spotter:
    def __init__(self, emission):
        self.emission = emission
        self.keyword_spotter = self
        self.graphs = []

    def create_stream(self, graph):
        self.graphs.append(graph)
        stream = types.SimpleNamespace(samples=0, ready=False, emitted=False)
        def accept(_rate, audio):
            stream.samples += len(audio)
            stream.ready = bool(len(audio))
        stream.accept_waveform = accept
        return stream

    def is_ready(self, stream):
        return stream.ready

    def decode_stream(self, stream):
        stream.ready = False

    def get_result(self, stream):
        at, keyword, times = self.emission
        if not stream.emitted and stream.samples >= at:
            stream.emitted = True
            return types.SimpleNamespace(keyword=keyword, timestamps=times)
        return types.SimpleNamespace(keyword='', timestamps=[])


class RecognitionPolicyTests(unittest.TestCase):
    def engine(self, keyword='clear', start=.08, end=.32, at=6400):
        engine = worker.Keywords.__new__(worker.Keywords)
        engine.command_silence = 3840
        engine.commands = Spotter((at, keyword, [start, end]))
        engine.wake = Spotter((at, keyword, [start, end]))
        engine.model = engine.wake
        engine.ensemble_wake = False
        engine.vocabulary = ['tokens @clear', 'tokens @prompt', 'tokens @prompt_cancel']
        engine.wake_vocabulary = ['tokens @ivy']
        engine.identity = None
        engine.reset()
        return engine

    def feed(self, engine, voiced, mode='listening', identity='test'):
        numpy = types.SimpleNamespace(sqrt=math.sqrt, mean=lambda a: sum(a)/len(a),
                                      asarray=lambda a, **_kw: Audio(a), float32=float)
        detections = []
        with patch.dict('sys.modules', {'numpy': numpy}), patch.object(worker, 'samples', side_effect=lambda request, _maximum: Audio(request['pcm'])):
            for sequence, active in enumerate(voiced):
                reply = engine.run({'stream_id': identity, 'sequence': sequence,
                                    'pcm': [1 if active is True else 0 if active is False else active] * 640,
                                    'threshold': .008, 'mode': mode})
                if reply['detection']:
                    detections.append((sequence, reply['detection']))
        return detections

    def test_standalone_control_requires_a_complete_quiet_boundary(self):
        detections = self.feed(self.engine(), [True]*10 + [False]*20)
        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0][0], 15)
        self.assertEqual(detections[0][1]['command'], 'clear')

    def test_prefixes_short_suffixes_and_restarted_speech_are_not_controls(self):
        self.assertEqual(self.feed(self.engine(start=.4, end=.6), [True]*18 + [False]*20), [])
        self.assertEqual(self.feed(self.engine(), [True]*18 + [False]*20), [])
        self.assertEqual(self.feed(self.engine(), [True]*10 + [False]*4 + [True]*8 + [False]*20), [])
        self.assertEqual(self.feed(self.engine(), [True]*10 + [.006]*6 + [False]*20), [])

    def test_prompt_cancel_is_only_actionable_and_in_the_graph_during_composition(self):
        listening = self.engine(keyword='prompt_cancel')
        self.assertEqual(self.feed(listening, [True]*10 + [False]*20), [])
        self.assertNotIn('@prompt_cancel', listening.commands.graphs[0])
        composing = self.engine(keyword='prompt_cancel')
        self.assertEqual(self.feed(composing, [True]*10 + [False]*20, 'composing')[0][1]['command'], 'prompt cancel')
        self.assertIn('@prompt_cancel', composing.commands.graphs[0])

    def test_passive_wake_does_not_wait_for_the_following_request_to_end(self):
        results = self.feed(self.engine(keyword='ivy'), [True]*20 + [False]*20, 'passive')
        self.assertEqual(len(results), 1)
        self.assertLess(results[0][0], 20)
        self.assertEqual(results[0][1]['end_sample'], 5760)

    def test_long_continuous_speech_bounds_acoustic_features_without_rearming_mid_sentence(self):
        engine = self.engine(at=99999999)
        self.assertEqual(self.feed(engine, [True]*250), [])
        self.assertLessEqual(engine.stream.samples, 96000)
        self.assertTrue(engine.fired)


if __name__ == '__main__':
    unittest.main()
