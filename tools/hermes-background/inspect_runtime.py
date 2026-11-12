"""Verify the candidate's pinned source surface without importing or changing Hermes."""
import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'config/hermes-compat/stellar-background-v1'))
from stellar_background.provenance import verify_runtime

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify_runtime(args.runtime), indent=2))
