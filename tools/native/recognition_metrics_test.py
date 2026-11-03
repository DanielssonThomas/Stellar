"""Miss-inclusive benchmark accounting; requires the local NumPy environment."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('replay', Path(__file__).with_name('replay-recognition.py'))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

class MetricsTests(unittest.TestCase):
    def test_misses_and_duplicates_cannot_hide_behind_success_only_latency(self):
        rows = [
            {'expected': 'clear', 'detections': [{'command': 'clear', 'endLatencyProxyMs': 200}]},
            {'expected': 'clear', 'detections': []},
            {'expected': 'clear', 'detections': [{'command': 'clear', 'endLatencyProxyMs': 200}]*2},
        ]
        result = replay.summary(rows)['clear']
        self.assertEqual((result['correct'], result['misses'], result['falseActivations']), (1, 1, 1))
        self.assertEqual(result['proxyWithinDeadline']['250'], 1)
        self.assertEqual(result['unmeasuredOrMissedLatencies'], 2)
        self.assertIsNone(result['missInclusiveProxyP95Ms'])

    def test_unknown_or_early_reference_time_is_not_a_fast_success(self):
        for time in (None, -20):
            result = replay.summary([{'expected': 'ivy', 'detections': [{'command': 'ivy', 'endLatencyProxyMs': time}]}])['ivy']
            self.assertEqual(result['correct'], 1)
            self.assertEqual(result['proxyWithinDeadline']['250'], 0)
            self.assertIsNone(result['successfulProxyMedianMs'])

if __name__ == '__main__':
    unittest.main()
