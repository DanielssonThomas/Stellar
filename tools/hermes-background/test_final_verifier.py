"""Negative evidence regressions; no runtime, source overlays or effect execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('actual_final_verifier', Path(__file__).with_name('verify_final.py'))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class EvidenceTests(unittest.TestCase):
    def test_incomplete_or_extra_consumer_delta_refused_against_immutable_git(self):
        changed = subprocess.run(['git', 'diff', '--name-only', verifier.CONSUMER_BASE, verifier.CONSUMER],
            cwd=verifier.REPO, check=True, capture_output=True).stdout.decode().splitlines()
        self.assertEqual(len(changed), 45)
        complete = {'consumer_base': verifier.CONSUMER_BASE, 'consumer_pre_postimages': dict.fromkeys(changed)}
        verifier.require_complete_consumer(complete)
        missing = json.loads(json.dumps(complete))
        missing['consumer_pre_postimages'].pop(changed[-1])
        with self.assertRaisesRegex(ValueError, 'complete immutable'):
            verifier.require_complete_consumer(missing)
        extra = json.loads(json.dumps(complete))
        extra['consumer_pre_postimages']['Cargo.toml'] = None
        with self.assertRaisesRegex(ValueError, 'complete immutable'):
            verifier.require_complete_consumer(extra)

    def test_valid_replaced_snapshot_with_same_answer_and_changed_projection_refuse(self):
        with tempfile.TemporaryDirectory(prefix='stellar339-evidence-') as directory:
            root = Path(directory)
            payloads = {'projected-frames.json': b'{"fixture":true}',
                'native-snapshot.json': b'{"fixtureOnly":true,"answer":"same answer","claim":"original"}'}
            report = {}
            for name, data in payloads.items():
                (root / name).write_bytes(data)
                report[name + '_sha256'] = hashlib.sha256(data).hexdigest()
            verifier.require_native_evidence(root, report)
            (root / 'native-snapshot.json').write_bytes(
                b'{"fixtureOnly":true,"answer":"same answer","claim":"replacement"}')
            with self.assertRaisesRegex(ValueError, 'native-snapshot'):
                verifier.require_native_evidence(root, report)
            (root / 'native-snapshot.json').write_bytes(payloads['native-snapshot.json'])
            (root / 'projected-frames.json').write_bytes(b'{"fixture":true,"other":1}')
            with self.assertRaisesRegex(ValueError, 'projected-frames'):
                verifier.require_native_evidence(root, report)


if __name__ == '__main__':
    unittest.main(verbosity=2)
