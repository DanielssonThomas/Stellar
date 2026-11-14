"""Qualification must refuse a failed or stale execution even with passing log text."""

import json
from pathlib import Path
import tempfile
import unittest

from seal_recovery_composition import ROOT, sha, verify_execution


class SealTests(unittest.TestCase):
    def fixture(self, output, exit_code=0):
        (output / "fixture.log").write_text("Ran 100 tests\n")
        record = {
            "exitCode": exit_code,
            "logSha256": sha((output / "fixture.log").read_bytes()),
            "runnerSha256": sha(
                (
                    ROOT / "tools/hermes-background/run_recovery_composition.py"
                ).read_bytes()
            ),
        }
        (output / "fixture.execution.json").write_text(json.dumps(record))
        return record

    def test_failed_command_cannot_qualify_from_passing_text(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            self.fixture(output, 1)
            with self.assertRaises(AssertionError):
                verify_execution("fixture.log", output)

    def test_replaced_log_or_runner_cannot_reuse_prior_success(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            record = self.fixture(output)
            (output / "fixture.log").write_text("different run\n")
            with self.assertRaises(AssertionError):
                verify_execution("fixture.log", output)
            self.fixture(output)
            record["runnerSha256"] = "0" * 64
            (output / "fixture.execution.json").write_text(json.dumps(record))
            with self.assertRaises(AssertionError):
                verify_execution("fixture.log", output)

    def test_exact_successful_execution_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            record = self.fixture(output)
            self.assertEqual(verify_execution("fixture.log", output), record)


if __name__ == "__main__":
    unittest.main()
