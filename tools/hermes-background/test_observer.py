"""Run existing observer/worker and producer bookkeeping suites without a runtime or profile."""
import importlib.util
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[2]
folder = root / 'config/hermes-plugins/stellar-herdr'
spec = importlib.util.spec_from_file_location('stellar_herdr', folder / '__init__.py',
                                             submodule_search_locations=[str(folder)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
suite = unittest.defaultTestLoader.loadTestsFromNames([
    'stellar_herdr.test_observation', 'stellar_herdr.test_workers', 'stellar_herdr.test_notifications'])
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(not result.wasSuccessful())
