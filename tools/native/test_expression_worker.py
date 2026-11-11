"""Check the worker's request boundary and score abstention without loading weights."""

import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest


WORKER = Path(__file__).resolve().parents[2] / (
    "apps/stellar-desktop/src-tauri/src/speech/expression_worker.py"
)
MODULE = runpy.run_path(str(WORKER))
LABELS = list(MODULE["LABELS"])
RATE = MODULE["RATE"]
bounded_pcm = MODULE["bounded_pcm"]
summarize = MODULE["summarize"]


class WorkerTests(unittest.TestCase):
    def test_pcm_boundary(self):
        self.assertIsNone(bounded_pcm({"sample_rate_hz": RATE, "pcm": [0] * RATE}))
        self.assertIsNone(bounded_pcm({"sample_rate_hz": RATE, "pcm": [500] * (RATE - 1)}))
        self.assertIsNone(bounded_pcm({"sample_rate_hz": RATE, "pcm": [True] * RATE}))
        self.assertIsNone(bounded_pcm({"sample_rate_hz": RATE * 3, "pcm": [500] * RATE}))
        self.assertIsNone(bounded_pcm({"sample_rate_hz": RATE, "pcm": [-32769] * RATE}))
        pcm = [-32768, 32767] * (RATE // 2)
        self.assertEqual(bounded_pcm({"sample_rate_hz": RATE, "pcm": pcm}), pcm)

    def test_retains_distinct_supported_labels(self):
        result = {"labels": LABELS, "scores": [0, 0, 0, 0.26, 0.14, 0, 0, 0.60, 0]}
        self.assertEqual(
            summarize(result),
            {"primary": "surprised", "secondary": "happy", "confidence": "moderate"},
        )

    def test_abstains_on_uncertainty_unknowns_or_invalid_model_output(self):
        for scores in (
            [0, 0, 0, 0.47, 0, 0, 0, 0.53, 0],
            [0, 0, 0, 0.15, 0, 0.85, 0, 0, 0],
            [0, 0, 0, 0.15, 0, 0, 0, 0, 0.85],
            [0, 0, 0, float("nan"), 0, 0, 0, 1, 0],
            [0, 0, 0, 0, 0, 0, 0, 0.50, 0],
        ):
            with self.subTest(scores=scores):
                self.assertIsNone(summarize({"labels": LABELS, "scores": scores}))
        self.assertIsNone(summarize({"labels": LABELS[::-1], "scores": [1] + [0] * 8}))

    def test_missing_model_and_later_frames_reply_without_expression(self):
        with tempfile.TemporaryDirectory() as missing:
            valid = json.dumps({"sample_rate_hz": RATE, "pcm": [500] * RATE})
            duplicate = valid.replace('"sample_rate_hz":', '"sample_rate_hz": 16000, "sample_rate_hz":')
            worker = subprocess.run(
                [sys.executable, "-I", "-u", str(WORKER), missing],
                input=("\n".join([duplicate, valid, valid]) + "\n").encode(),
                capture_output=True, check=True, timeout=10,
            )
            self.assertEqual(
                [json.loads(line) for line in worker.stdout.splitlines()],
                [{"expression": None}] * 3,
            )


if __name__ == "__main__":
    unittest.main()
