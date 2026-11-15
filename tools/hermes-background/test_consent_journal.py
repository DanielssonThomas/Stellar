"""Run ONLY disposable consent-journal tests with pinned canonical SQLite code."""
import argparse
import importlib.abc
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class NoRuntime(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in ('hermes_bootstrap', 'gateway.run', 'run_agent'):
            raise RuntimeError('offline journal tests prohibit runtime entry')


def forbidden(*args, **kwargs):
    raise RuntimeError('offline journal tests prohibit network/process dispatch')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--ledger-regression', action='store_true')
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(ROOT / 'config/hermes-compat/native-consent'),
        str(ROOT / 'config/hermes-compat/stellar-background-v1'), str(args.runtime.resolve())]
    sys.meta_path.insert(0, NoRuntime())
    with tempfile.TemporaryDirectory(prefix='stellar339-journal-home-') as home:
        os.environ['HERMES_HOME'] = home
        with patch.object(socket, 'socket', forbidden), patch.object(subprocess, 'Popen', forbidden):
            from stellar_background.provenance import verify_runtime
            verify_runtime(args.runtime.resolve())
            suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent / 'consent_journal_tests'),
                pattern='test_*.py', top_level_dir=str(Path(__file__).parent))
            if args.ledger_regression:
                import test_candidate
                test_candidate.RUNTIME = args.runtime.resolve()
                suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(test_candidate.CandidateTests))
            result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(0 if result.wasSuccessful() else 1)
