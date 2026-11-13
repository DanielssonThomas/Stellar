"""Only pure guards/recording backends; never live process or maintenance calls."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import importlib.util

spec = importlib.util.spec_from_file_location(
    "qualification_operator", Path(__file__).with_name("external_operator.py")
)
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)


class OperatorTests(unittest.TestCase):
    def metadata(self):
        return {
            "independent": True,
            "ordinaryToken": True,
            "session": op.SESSION,
            "gateway": {
                "profiles": op.PROFILES,
                "pid": 123,
                "live": True,
                "allGatewayPids": [123],
                "activeAgents": 0,
                "activeWorkCount": 0,
            },
            "conversation": {"pending_reset": None},
            "producerPostimages": {},
        }

    def test_blocked_qualification_never_enters_any_live_backend(self):
        with self.assertRaisesRegex(RuntimeError, "replay gap"):
            op.admit(
                {"status": "BLOCKED", "blockers": ["replay gap"]},
                "silence-or-timer",
                self.metadata(),
            )

    def test_green_fixture_requires_explicit_later_handoff_not_elapsed_time(self):
        report = {
            "status": "GREEN",
            "candidate": op.CANDIDATE,
            "desktopSha256": op.EXE_SHA,
            "operatorSha256": "a" * 64,
            "helperHashes": {str(path): "a" * 64 for path in op.protected_inputs()},
            "producerPostimages": {},
        }
        with patch.object(op, "digest", return_value="a" * 64):
            for acknowledgement in [
                "",
                "time elapsed",
                "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_old",
            ]:
                with self.assertRaisesRegex(RuntimeError, "handoff missing"):
                    op.admit(report, acknowledgement, self.metadata())
            op.admit(
                report,
                "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_" + "a" * 16,
                self.metadata(),
            )

    def test_busy_foreign_scope_or_unknown_process_context_refuses(self):
        report = {
            "status": "GREEN",
            "candidate": op.CANDIDATE,
            "desktopSha256": op.EXE_SHA,
            "operatorSha256": "a" * 64,
            "helperHashes": {str(path): "a" * 64 for path in op.protected_inputs()},
            "producerPostimages": {},
        }
        mutations = [
            lambda m: m["gateway"].update(activeAgents=1),
            lambda m: m["gateway"].update(profiles=["ivy"]),
            lambda m: m["gateway"].update(allGatewayPids=[123, 456]),
            lambda m: m.update(ordinaryToken=False),
            lambda m: m.update(independent=False),
        ]
        with patch.object(op, "digest", return_value="a" * 64):
            for mutate in mutations:
                metadata = deepcopy(self.metadata())
                mutate(metadata)
                with self.assertRaises(RuntimeError):
                    op.admit(
                        report,
                        "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_" + "a" * 16,
                        metadata,
                    )

    def test_failure_checkpoints_without_restoring_or_clearing_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unknown = root / "fake-unknown.json"
            unknown.write_text(
                '{"fixture":true,"outcome":"UNKNOWN","speech_claim":"retained"}'
            )
            before = unknown.read_bytes()
            calls = []

            def fail(step, mode):
                calls.append((step, mode))
                if step == "apply_source":
                    raise OSError("FIXTURE source completion failed")

            with self.assertRaises(OSError):
                op.workflow("cutover", fail, root / "continuation.json")
            state = json.loads((root / "continuation.json").read_text())
            self.assertEqual(state["phase"], "RECOVERY_REQUIRED")
            self.assertFalse(state["stateRestorePerformed"])
            self.assertFalse(state["canonicalReceipt"])
            self.assertEqual(unknown.read_bytes(), before)
            self.assertNotIn(("start_host", "cutover"), calls)

    def test_retained_candidate_filename_is_recognized_for_recovery_and_unknown_path_refuses(
        self,
    ):
        with patch.object(op, "digest", return_value=op.EXE_SHA):
            identity = op.desktop_identity(op.BINARY.name, str(op.BINARY))
            self.assertTrue(identity["approved"])
            other = op.desktop_identity(
                op.BINARY.name, "D:/unreviewed/stellar-desktop-a0eea43-e35a746.exe"
            )
            self.assertFalse(other["approved"])

    def test_source_or_helper_drift_refuses_before_any_backend(self):
        report = {
            "status": "GREEN",
            "candidate": op.CANDIDATE,
            "desktopSha256": op.EXE_SHA,
            "operatorSha256": "a" * 64,
            "producerPostimages": {},
            "helperHashes": {str(path): "a" * 64 for path in op.protected_inputs()},
        }
        with patch.object(op, "digest", return_value="a" * 64):
            changed = self.metadata()
            changed["producerPostimages"] = {"unreviewed.py": "changed"}
            with self.assertRaisesRegex(RuntimeError, "Producer inventory"):
                op.admit(
                    report, "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_" + "a" * 16, changed
                )
            report["helperHashes"] = {}
            with self.assertRaisesRegex(RuntimeError, "Execution helper"):
                op.admit(
                    report,
                    "IVY_MAINTENANCE_HANDOFF_COMPLETE_339_" + "a" * 16,
                    self.metadata(),
                )

    def test_recording_forward_recovery_waits_for_real_conversation_check(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            state = op.workflow(
                "recover",
                lambda step, mode: calls.append((step, mode)),
                Path(directory) / "continuation.json",
            )
            self.assertIn(("publish_producer", "recover"), calls)
            self.assertEqual(state["phase"], "AWAIT_ORDINARY_INTERACTION")
            self.assertFalse(state["canonicalReceipt"])
            self.assertFalse(any("prompt.submit" in step for step, _ in calls))


if __name__ == "__main__":
    unittest.main()
